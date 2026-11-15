---
title: Gauntlet AI Fellowship - AI Engineer, Challenger, Cohort 4 (Apr - Aug 2026)
url: "#gauntlet"
---

## Fellowship summary
Gauntlet AI Fellowship, Austin, TX, April 2026 to August 2026. Jayce was an AI Engineer "Challenger" in Cohort 4, an intensive AI software engineering fellowship where fellows build and ship production-grade AI projects on weekly deadlines.

## TTB Label Verification Tool
Stack: Python, FastAPI, LangGraph, Claude and Ollama, Postgres, Docker, GitHub Actions. Built and deployed an AI compliance tool that checks alcohol beverage labels against 27 CFR (TTB regulations) and returns PASS/FLAG verdicts. Scored 100% correct decisions on a 24-case eval set with a 211 ms worst-case response, and hands unreadable labels to a human reviewer instead of guessing. The LangGraph assistant runs on Claude in the cloud or Ollama locally, with human confirmation on every write and a hash-chained audit log in Postgres. It uses citation-grounded RAG over 27 CFR with BM25 and BGE embeddings combined by reciprocal rank fusion, and refuses when the regulations don't cover the question. Every release was gated on 446 automated tests, a RAG eval and a replayed agent-behavior eval in GitHub Actions. Jayce fixed 21 CVEs and added upload limits and security headers before launch. Code: github.com/jayceparabellum/TTB_AI_Label_Verification_Tool

## Multi-Agent AI Security Platform
Stack: Python, FastAPI, Pydantic, Docker. Designed and deployed in 4 days a five-agent system that continuously red-teams a clinical LLM app. The attacking agent never grades itself: a separate Judge agent scores results against versioned rubrics. Typed, logged handoffs make every campaign replayable, a per-agent cost ledger shuts campaigns down at 120% of budget, and threat intel from 8 sources (OWASP LLM Top 10, MITRE ATLAS, NIST AI 600-1, CISA KEV and others) generates new test cases. Code: github.com/jayceparabellum/agentforge-ai-security-platform

## AgentForge Clinical Co-Pilot
Stack: OpenEMR, OpenAI Responses API, JSON Schema, Docker. Built a read-only clinical co-pilot that writes source-cited pre-visit summaries. Every item must cite a patient record or it is removed before display, and permission checks run server-side before any data reaches the model. Also built a RAG pipeline on Pinecone to ingest patient intake documents for a medical facility running OpenEMR.

## FleetGraph and U.S. Treasury platform audit
Stack: LangGraph, TypeScript, AWS, Terraform. Built a LangGraph agent with LangSmith tracing and admin approval for high-severity actions. Deployed a scheduled security scanner on AWS with Terraform (EventBridge, Lambda, CodeBuild, S3), cut the initial JavaScript bundle by 77%, and reduced API p95 latency by over 30%.

## Other public repositories
Jayce's GitHub (github.com/jayceparabellum) also includes CU-Boulder (completed coursework from his AI master's program), and published agent skills such as a Six Sigma verification-stage skill for coding agents.

## Secure CI/CD demo
github.com/jayceparabellum/secure-cicd-demo is a small Python FastAPI app with a browser UI that audits HTTP security response headers (HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy) and returns a 0-100 score with findings. Its real purpose is demonstrating a secure CI/CD pipeline in GitHub Actions: tests, static analysis, dependency auditing, CodeQL code scanning, Dependabot, and container publishing to GitHub Container Registry. The app deliberately doesn't fetch target URLs, to avoid server-side request forgery risk.
