---
title: About this AI assistant
url: "#ask"
---

## How this chatbot works
This site's assistant is a retrieval-augmented generation (RAG) system that Jayce built to showcase his AI engineering. The knowledge base is a set of curated markdown files about Jayce's career, chunked by section. For each question, a Cloudflare Worker (1) rewrites follow-up questions into standalone search queries with Claude, (2) runs hybrid retrieval: BM25 keyword search plus dense vector search with BGE embeddings on Cloudflare Workers AI, (3) merges both rankings with reciprocal rank fusion, (4) reranks the candidates with a BGE cross-encoder reranker, and (5) streams a grounded answer from Claude Haiku that cites its sources and declines when the knowledge base doesn't cover the question. Rate limiting, input limits, an origin allowlist and prompt-injection rules protect the endpoint, and the API key never reaches the browser. The code is public in the site's GitHub repository under chat-worker/.

## What it will not do
The assistant only answers questions about Jayce Nhan Parabellum's career, skills, projects, service and public interests. It will not share private details such as phone number, home address, or credential numbers, it won't speculate about salary expectations, and it doesn't make up facts that aren't in its sources.
