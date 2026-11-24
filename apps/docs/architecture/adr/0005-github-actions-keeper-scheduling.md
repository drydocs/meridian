# ADR-0005: Schedule keepers with GitHub Actions

- Status: Accepted

## Context

Production keepers must run more frequently than once per day. The Vercel Hobby
plan's Cron Jobs restriction cannot express the accrual keeper's 15-minute
interval or the migration keeper's hourly interval.

## Decision

Use the repository's GitHub Actions scheduled workflow to call the keeper API
routes. The accrual keeper runs every 15 minutes; the migration keeper runs
hourly. Calls are authenticated with `CRON_SECRET`.

## Alternatives considered

- Use Vercel Cron Jobs. Rejected because the Hobby plan allows only daily
  schedules, which are too infrequent for these keepers.
- Operate a separate always-on scheduler. Rejected to avoid adding another
  service to deploy and maintain.

## Consequences

Scheduling reuses the repository's CI platform and avoids a separate runtime.
GitHub scheduled-workflow timing is best-effort, and GitHub disables scheduled
workflows after 60 days without repository activity; forks and long-inactive
repositories must account for this.
