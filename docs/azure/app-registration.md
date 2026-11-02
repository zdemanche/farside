# Azure app registration (E1-S6-T2)

**Status:** adopted per owner direction, Nov 2 2026. Ryan Morris and Kevin review of this note is satisfied by that direction; it does not claim a separate personal comment from either of them.

Open questions that still need live proof (E1-S7), not a product decision:

1. Which Moonaan Entra tenant is the home tenant for the registration (existing identity tenant vs a new one).
2. Whether customer grant is admin-consent to the multi-tenant app, Azure Lighthouse, or subscription IAM on a service principal — default below is admin-consent plus RBAC.
3. Federated exchange against a real customer-shaped tenant (no live tenant here).

## Choice

| Topic | Choice |
|---|---|
| Where the app is created | A **multi-tenant** app registration in a **Moonaan-owned** Entra ID tenant (the home tenant). |
| Secrets | **None.** No client secret, no uploaded certificate used as a long-lived password. |
| How the app authenticates | **Federated credentials** (workload identity federation). The workload (GitHub Actions OIDC and/or a managed identity in the customer’s dedicated Moonaan account, once that integration is switched on) is the subject of the federated credential. |
| Customer tenants | The customer’s Entra admin consents to the app. Farside’s service principal in that tenant is then granted the **read-only** roles below on the subscriptions in scope. Farside never stores a customer secret. |
| Test subscription | **Must be in a different tenant** from the app registration (D3). Same-tenant tests would skip the cross-tenant path. |
| Roles requested | Reader, Cost Management Reader, Monitoring Reader, Reservations Reader, and Backup Reader if vault items are needed. |

This is the industry default for an unattended multi-tenant SaaS read of Azure: federated credentials instead of a client secret (dashmeta’s Azure adapter used a client secret; that path is not reused).

## What is not done

- The app registration itself is not created (needs an Entra tenant this workspace does not control).
- Cross-tenant federated access is not proven live ([E1-S7-T2](https://github.com/zdemanche/farside/issues/42)).
- Dedicated AWS account / iac-hub wiring for the workload identity is a switch-on-later integration, not a blocker for this decision.
