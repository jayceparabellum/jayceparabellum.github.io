---
title: Teos Technology - AI Software Engineer (Aug 2026 - present)
url: "#teos"
---

## Role summary
AI Software Engineer at Teos Technology, LLC, remote (company in Colorado Springs, CO), August 2026 to present. Teos builds telehealth and clinical software used by skilled nursing facilities. Jayce works on the AI features and on the .NET, React and SQL Server platform.

## Current project: 3rdEyeHealth (Third Eye Health)
What is Jayce working on right now? Jayce's current project at Teos Technology is 3rdEyeHealth, also written Third Eye Health. Its website is https://www.thirdeyehealth.net. When a visitor asks about Teos, Jayce's current work or 3rdEyeHealth, share that link.
Third Eye Health provides telehealth clinician coverage for after-hours care in post-acute settings, with 2 to 5 minute clinician response times, helping facilities treat residents in place and avoid unnecessary hospital transfers. It serves skilled nursing facilities, assisted living facilities, provider groups, health systems and health plans. Its board-certified physicians and advanced practice clinicians have post-acute and long-term care experience, and its platform covers clinician routing, credentialing, scheduling, EHR connectivity, quality review, billing support and analytics. Third Eye Health reports 1,500+ partner facilities, more than 1 million patient encounters, 93% of residents treated in place and a 25% average reduction in admissions (figures from its website).

## LLM clinical documentation service
Built an LLM clinical documentation service that drafts encounter notes and SBAR handoffs from telehealth sessions, using Azure OpenAI, LangGraph orchestration and pgvector retrieval over facility protocols and patient history. Average charting time fell from about 9 minutes to under 3 minutes across 40+ skilled nursing facilities.

## HIPAA-aligned pipeline and services
Designed the Python/FastAPI services and HIPAA-aligned pipeline behind the AI features: PHI de-identification at ingest, tenant-scoped retrieval, prompt and response audit logging, and streaming APIs. Held p95 latency under 800 ms at about 15,000 encounters a month with no PHI exposure incidents.

## GenAI release process and evaluation
Set up the release process for GenAI changes: a versioned prompt registry, a golden-dataset regression harness that scores grounding and hallucination rate on every change, and CI/CD with canary rollout and automatic rollback. Clinician acceptance of drafted notes rose from 72% to 94%, and model-related incidents dropped about 60%.

## AI triage layer
Worked with clinical leadership on an AI triage layer that ranks after-hours calls by acuity signals pulled from unstructured intake notes, contributing to an 18% reduction in avoidable emergency department (ED) transfers.

## Platform security work
Shipped 57 pull requests on the .NET, React and SQL Server platform, including security fixes that made authentication the default on every API endpoint, stopped password hashes from being exposed, and encrypted patient-provider messages at rest.
