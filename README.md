# inspection-api

Single backend Edge Function for the UFUQ branch inspection website.
The frontend never talks to the database directly — every request goes
through this function as `POST { action, ...payload }`.

## Required secrets (Edge Functions → Secrets)

| Name         | Notes                                                         |
|--------------|-----------------------------------------------------------------|
| `APP_PASSWORD` | The login password used by the dashboard.                    |
| `JWT_SECRET`   | Any long random string, used to sign session tokens.          |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` do **not** need to be set
manually — Supabase provides them automatically to every Edge Function.

## Actions

| action          | auth required | purpose                                  |
|-----------------|---------------|-------------------------------------------|
| `ping`          | no            | connectivity check                        |
| `login`         | no            | exchange password for a session token     |
| `bootstrap`     | yes           | load branches/forms/groups/products       |
| `date`          | yes           | set the active inspection date            |
| `groups`        | yes           | create a product group                    |
| `products`      | yes           | create a product                          |
| `dates-group`   | yes           | apply production/expiry dates to a group  |
| `dates-product` | yes           | apply production/expiry dates to 1 product|
| `invoices`      | yes           | process extracted invoice text             |
| `form`          | yes           | load one form with today's checkmarks     |
| `reset`         | yes           | clear today's ✓ checkmarks only            |

## Deploying

Easiest path: Supabase Dashboard → Edge Functions → inspection-api → Code
→ select all → delete → paste the full contents of `index.ts` → Deploy.

Make sure nothing else remains in the editor before pasting — a stray
leftover template (even one blank character) will cause a bundling error.
