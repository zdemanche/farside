#!/usr/bin/env python3
"""Create GitHub issues from backlog/backlog.json.

Hierarchy is epic > story > task, using GitHub sub-issues. Progress is saved to
backlog/issue-map.json after every write, so a stopped run can be re-run safely
without creating duplicates.

Usage: python3 scripts/import_backlog.py [--dry-run] [--limit-epics N]
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = "zdemanche/farside"
ROOT = Path(__file__).resolve().parent.parent
BACKLOG = ROOT / "backlog" / "backlog.json"
ISSUE_MAP = ROOT / "backlog" / "issue-map.json"
PAUSE_SECONDS = 1.0
MAX_ATTEMPTS = 6
LABEL_COLORS = {
    "epic": "6f42c1", "story": "1649ed", "task": "8b949e", "decision": "ffcd00",
    "size:S": "c2e0c6", "size:M": "fef2c0", "size:L": "f9d0c4",
}


def gh(method, path, payload=None):
    """Call the GitHub API, retrying rate limits and server errors."""
    command = ["gh", "api", "-X", method, path]
    data = None
    if payload is not None:
        command += ["--input", "-"]
        data = json.dumps(payload)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        result = subprocess.run(command, input=data, capture_output=True, text=True)
        if result.returncode == 0:
            time.sleep(PAUSE_SECONDS)
            return json.loads(result.stdout) if result.stdout.strip() else {}
        message = result.stdout + result.stderr
        if "already_exists" in message or "already exists" in message:
            return {}
        retryable = any(code in message for code in ("rate limit", "HTTP 403", "HTTP 429", "HTTP 50"))
        if not retryable or attempt == MAX_ATTEMPTS:
            raise RuntimeError(f"{method} {path} failed: {message[:400]}")
        wait = 20 * attempt
        print(f"  retrying in {wait}s ({method} {path})", flush=True)
        time.sleep(wait)
    raise RuntimeError(f"{method} {path} failed")


def save(state):
    ISSUE_MAP.write_text(json.dumps(state, indent=2) + "\n")


def ensure_labels(backlog):
    areas = {area for epic in backlog["epics"] for story in epic["stories"] for area in story.get("areas", [])}
    wanted = dict(LABEL_COLORS)
    wanted.update({f"area:{area}": "d4e5ff" for area in sorted(areas)})
    existing = {label["name"] for label in gh("GET", f"repos/{REPO}/labels?per_page=100")}
    for name, color in wanted.items():
        if name not in existing:
            gh("POST", f"repos/{REPO}/labels", {"name": name, "color": color})


def ensure_milestones(backlog):
    existing = {m["title"]: m["number"] for m in gh("GET", f"repos/{REPO}/milestones?state=all&per_page=100")}
    numbers = {}
    for epic in backlog["epics"]:
        title = f"Phase {epic['phase']}: {epic['title']}"
        if title not in existing:
            existing[title] = gh("POST", f"repos/{REPO}/milestones", {"title": title, "description": epic["goal"]})["number"]
        numbers[epic["key"]] = existing[title]
    return numbers


def create(state, key, title, body, labels, milestone=None, dry_run=False):
    """Create one issue unless the map says it already exists."""
    if key in state["issues"]:
        return
    full_title = f"{key}: {title}"
    if dry_run:
        print(f"  would create {full_title}")
        return
    payload = {"title": full_title, "body": body, "labels": labels}
    if milestone:
        payload["milestone"] = milestone
    issue = gh("POST", f"repos/{REPO}/issues", payload)
    state["issues"][key] = {"number": issue["number"], "id": issue["id"]}
    save(state)
    print(f"  #{issue['number']} {full_title}", flush=True)


def epic_body(epic):
    return f"{epic['goal']}\n\n**Phase:** {epic['phase']}\n\nStories are listed as sub-issues below."


def story_body(story):
    lines = [story["story"], "", "## Acceptance criteria", ""]
    lines += [f"- [ ] {item}" for item in story["acceptance"]]
    if story.get("notes"):
        lines += ["", "## Notes", "", story["notes"]]
    return "\n".join(lines)


def link_sub_issue(state, parent_key, child_key):
    link = f"{parent_key}>{child_key}"
    if link in state["links"]:
        return
    parent = state["issues"][parent_key]["number"]
    child_id = state["issues"][child_key]["id"]
    gh("POST", f"repos/{REPO}/issues/{parent}/sub_issues", {"sub_issue_id": child_id})
    state["links"].append(link)
    save(state)


def link_dependency(state, blocked_key, blocker_key):
    link = f"{blocked_key}<{blocker_key}"
    if link in state["dependencies"]:
        return
    blocked = state["issues"][blocked_key]["number"]
    blocker_id = state["issues"][blocker_key]["id"]
    gh("POST", f"repos/{REPO}/issues/{blocked}/dependencies/blocked_by", {"issue_id": blocker_id})
    state["dependencies"].append(link)
    save(state)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit-epics", type=int)
    args = parser.parse_args()

    backlog = json.loads(BACKLOG.read_text())
    epics = backlog["epics"][: args.limit_epics] if args.limit_epics else backlog["epics"]
    state = json.loads(ISSUE_MAP.read_text()) if ISSUE_MAP.exists() else {"issues": {}, "links": [], "dependencies": []}

    milestones = {}
    if not args.dry_run:
        ensure_labels(backlog)
        milestones = ensure_milestones(backlog)

    print("Decisions", flush=True)
    for decision in backlog.get("decisions", []):
        body = f"{decision['body']}\n\n**Owner:** {decision['owner']}"
        create(state, decision["key"], decision["title"], body, ["decision"], dry_run=args.dry_run)

    for epic in epics:
        print(f"Epic {epic['key']}", flush=True)
        milestone = milestones.get(epic["key"])
        create(state, epic["key"], epic["title"], epic_body(epic), ["epic"], milestone, args.dry_run)
        for story in epic["stories"]:
            labels = ["story", f"size:{story['size']}"] + [f"area:{a}" for a in story.get("areas", [])]
            create(state, story["key"], story["title"], story_body(story), labels, milestone, args.dry_run)
            for task in story["tasks"]:
                create(state, task["key"], task["title"], task["body"], ["task"], milestone, args.dry_run)

    if args.dry_run:
        return

    print("Linking sub-issues", flush=True)
    for epic in epics:
        for story in epic["stories"]:
            link_sub_issue(state, epic["key"], story["key"])
            for task in story["tasks"]:
                link_sub_issue(state, story["key"], task["key"])

    print("Linking dependencies", flush=True)
    failures = []
    for epic in epics:
        for story in epic["stories"]:
            pairs = [(story["key"], b) for b in story.get("blockedBy", [])]
            for task in story["tasks"]:
                pairs += [(task["key"], b) for b in task.get("blockedBy", [])]
            for blocked, blocker in pairs:
                if blocked in state["issues"] and blocker in state["issues"]:
                    try:
                        link_dependency(state, blocked, blocker)
                    except RuntimeError as error:
                        failures.append(str(error)[:200])
    for decision in backlog.get("decisions", []):
        for blocked in decision.get("blocks", []):
            if blocked in state["issues"]:
                try:
                    link_dependency(state, blocked, decision["key"])
                except RuntimeError as error:
                    failures.append(str(error)[:200])

    print(f"Issues: {len(state['issues'])}  sub-issue links: {len(state['links'])}  dependencies: {len(state['dependencies'])}")
    if failures:
        print(f"Dependency failures: {len(failures)}; first: {failures[0]}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
