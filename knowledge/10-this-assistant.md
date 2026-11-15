---
title: About this AI assistant
url: "#ask"
---

## How this chatbot works
This site's assistant is a retrieval-augmented generation (RAG) system that Jayce built to showcase his AI engineering. The knowledge base is a set of curated markdown files about Jayce's career, chunked by section. For each question, a Cloudflare Worker (1) rewrites follow-up questions into standalone search queries with Llama 3.1 8B, (2) runs hybrid retrieval: BM25 keyword search plus dense vector search with BGE embeddings on Cloudflare Workers AI, (3) merges both rankings with reciprocal rank fusion, (4) reranks the candidates with a BGE cross-encoder reranker, and (5) streams a grounded answer from Meta's Llama 3.3 70B model, running on Cloudflare Workers AI, that cites its sources and declines when the knowledge base doesn't cover the question. Rate limiting, input limits, an origin allowlist, prompt-injection rules and signed conversation history protect the endpoint, and everything runs on Cloudflare's free tier with no third-party API keys. The code is public in the site's GitHub repository under chat-worker/.

## What it will not do
The assistant only answers questions about Jayce Nhan Parabellum's career, skills, projects, service and public interests. It will not share private details such as phone number, home address, or credential numbers, it won't speculate about salary expectations, and it doesn't make up facts that aren't in its sources.

## Contact form in the chat
The chat has a Contact Jayce form for hiring inquiries. Visitors choose freelance or contract work, a full-time corporate role, or consulting, add their name, email, optional company and a message, and can include the chat so far for context. The Worker emails it straight to Jayce's inbox through the FormSubmit relay, with the visitor's address set as the reply-to, so Jayce answers by email. The form is rate-limited and filters spam bots. If it is ever unavailable, visitors can email jayce.n.parabellum@gmail.com.

## About this website
This is Jayce Nhan Parabellum's personal website, jayceparabellum.github.io, a static site hosted on GitHub Pages. Its sections are: the summary at the top; How I build (Jayce's engineering principles); the career story, from military service through federal IT to AI engineering; Builds (public GitHub repositories); Credentials (education, certifications with Credly proof links, awards and decorations, military and technical training, and the toolset); Off the clock (life in Denver, community work and photos); this AI assistant; and Contact. Jayce designed and built the site. A QR code on Jayce's resume and CV opens this assistant directly. The resume PDF linked on the site is a web copy of Jayce's AI Engineering resume.
