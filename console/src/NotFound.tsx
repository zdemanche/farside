export function NotFound({ hash }: { hash: string }) {
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Page not found
      </h1>
      <p className="screen-state">
        There is no page at <code>#{hash}</code>. <a href="#estate">Go to Estate</a>
      </p>
    </>
  );
}
