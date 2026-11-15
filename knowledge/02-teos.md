---
title: Teos Technology - AI Software Engineer (Aug 2026 - present)
url: "#teos"
---

## About Teos Technology
Teos Technology, LLC is a founder-led software and AI company in Monument, Colorado (website: teos-tech.com). Its tagline is "Ethical AI and Custom Software for a Better Future." Teos designs and builds responsible AI systems, cloud-native applications and human-centered digital products, with security and privacy built in from the start, taking work from idea to prototype to production. Its services are AI consulting, custom software development, cloud architecture and DevOps, product strategy and agile delivery, and web design and hosting. Healthcare and wellness is a focus industry. Projects shown on its website include a Natural Healthcare Platform, a Life-Saving AI Application, a Civil Discourse Platform, and Let's Breathe & CheckIn. Scott J. Swindell is CEO, Chief Architect and Quality Lead.

## Jayce's role
Jayce is an AI Software Engineer at Teos Technology (remote, August 2026 to present), working on a Teos healthcare platform with web, mobile and API clients. Tech stack: .NET 10, ASP.NET Core, EF Core, SQL Server, React 18 with TypeScript, Expo / React Native, and Azure DevOps.

## Results at Teos
- Delivered 133 merged pull requests in 8 weeks, closing 62 bugs, 24 user stories and 25 tasks, using AI coding agents (Claude Code) inside a reviewed, layered-architecture workflow.
- Authored 80% of all commits to the main development branch in that period, including 19 new database tables and 14 API controllers.
- Raised automated test coverage by about 1,500 unit tests (from about 1,000 to 2,640 test methods, with 3,298 test cases passing) and about 200 Cypress end-to-end tests (from 32 to 75 spec files).
- Shipped about 29 security pull requests (details under Security hardening).
- Wrote the project's ARCHITECTURE.md, the reference the codebase is built to.
Jayce's work follows the team's process: a work item for every change, one branch and pull request per ticket, required code review, and the layering rules in the architecture guide.

## Product features Jayce built
- Messaging: reading and sending messages, with message subject and body encrypted in the database (AES-256-GCM).
- Appointment reminders: who gets reminded and when, the reminder text, cancelled-appointment handling, a shared scheduled-job mechanism, email and SMS delivery with tracking, and notifications to providers.
- Sign in with Apple on web, API and iOS.
- Desktop layout and accessibility: a grouped sidebar, a shared page header and table defaults, keyboard and screen-reader fixes, and confirmations before deleting records.
- Provider directory: provider search, public provider profiles, and a switch that lets providers hide their profile.
- Inventory and compliance: batches with unique IDs, product history and traceability, quality inspections, chain of custody, audit packages exported as CSV or zip, and license-expiry alerts.
- Billing and accounting: invoicing, payments and billing pages; a tax report, outstanding balances, expenses with profit and loss, and revenue metrics; billing for products and for completed appointments.
- Security monitoring: a security events log and page, recording of permission violations, account lockout, and suspicious-activity alerts.
- Other features: home-page advertisements with an admin page, and remedy information covering traditional uses and research.

## Security hardening
Jayce did a round of security hardening on the platform: secret scanning that fails the build if a secret is committed, moving signing keys out of configuration and rejecting weak keys, HSTS and browser security headers, CORS limited to each environment's own site, rate limits on anonymous endpoints, no internal error details in server errors, tighter access control so records are visible only to the people who should see them, fixes for cross-site scripting and unsafe rendering of chatbot answers, keeping tokens out of logs and password hashes out of API responses, and safer registration with email confirmation and a change-password flow.

## Reliability, DevOps and mobile
- Deployment checks: deploys fail with the names of any missing pipeline variables, the health check verifies the database, and test environments can only email approved addresses.
- Data integrity: prevented double-bookings and double-billing, made simultaneous invoice edits return a conflict instead of overwriting each other, and compared appointment times in each organization's own time zone.
- Mobile: a committed lockfile, type errors fixed and type-checking in CI, and fixes to registration, sign-out and role handling.
- Tests and documentation: a large batch of unit tests, Cypress end-to-end tests for most features, the project's architecture guide, and its list of reusable building blocks.

## How Jayce works with an AI coding agent
Jayce uses an AI coding agent inside the team's process rather than around it. After a few early stacked pull requests were merged before approval and had to be reverted and redone, the team made code review required on every pull request and added a rule that every pull request includes screenshots of passing tests and the running UI. Before starting a ticket Jayce checks whether anyone else is assigned to it or has branches touching the same files, and keeps each change within what the ticket describes.
