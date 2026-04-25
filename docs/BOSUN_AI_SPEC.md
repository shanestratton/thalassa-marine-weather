# Project Bosun — Marine-Domain LLM for Thalassa

**Author:** Claude (Anthropic) — drafted in conversation with Shane Stratton
**Date drafted:** April 26, 2026
**Status:** Strategic vision document. Not in active development. Parked for post-TestFlight (Q3–Q4 2026).
**Codename:** Bosun (the traditional deck specialist who knows where every shackle is and how every line runs)

---

## Executive summary

Thalassa is currently the most capable marine weather + anchor + chart-aware app in the recreational marine space. The competitive moat is product depth and design — but product depth alone can be copied within 12–18 months by Orca, Savvy Navvy, or a re-energized PredictWind.

**The durable moat is data + AI personalization that compounds per-vessel over time, running locally on the boat.**

Project Bosun is the plan to build that moat: a marine-domain language model fine-tuned on a curated corpus of seamanship, navigation, mechanical, electrical, and meteorological knowledge, running locally on the existing Raspberry Pi cache hub already deployed on customer boats, with a personalization loop that makes the model demonstrably smarter for THIS skipper's specific vessel over time.

**It is not a chatbot. It is a category creator.** No competitor in the recreational marine space has a working AI that operates offline at sea, persists vessel-specific context across years of ownership, and delivers latency that feels like a conversation with a working sailor rather than a cloud API round-trip via Iridium.

Estimated timeline: 6–7 months from project start to v1.0 production.
Estimated build cost: $50k–150k AUD depending on corpus licensing decisions and team composition.

---

## The problem

Cloud LLMs (Claude, GPT-5, Gemini) are competent generalists with passable marine knowledge. They are also:

1. **Useless at sea without comms.** A Brisbane-to-Hobart passage spends ~36–48 hours beyond reliable cellular. Iridium is slow, expensive per-token, and unsuitable for conversational use. Starlink Maritime is improving but still requires a clear-sky horizon and a $200/mo plan minimum.
2. **Privacy-hostile for sailors.** Skippers care more about data sovereignty than tech-bro users — vessel position, routing intent, financial transactions through the chandlery, service history, crew composition. "We send everything to OpenAI" is a hard sell to anyone who has been hacked or stalked.
3. **Latency-bound.** Even online, a cloud LLM round-trip via cellular is 3–8 seconds. Via marine satcom: 15–60 seconds. Conversation dies.
4. **Context-amnesiac.** The cloud LLM has no persistent knowledge of YOUR boat. Every session starts cold. After 18 months of ownership, your boat has accumulated thousands of micro-decisions that an onboard model would have learned and a cloud model has forgotten.

Generic competence is not enough. The market need is **specialist intelligence that lives on the vessel and gets smarter every voyage.**

---

## The vision

Bosun is the AI sailor on your boat.

- It runs locally on the Raspberry Pi cache hub Thalassa already deploys.
- It is fine-tuned on a marine-specific corpus covering seamanship, navigation, regulations, manufacturer service manuals, weather decoding, and gear maintenance.
- It is augmented by a RAG (Retrieval-Augmented Generation) layer over a vector store of YOUR boat's manuals, service history, and conversation logs.
- It learns from every cloud LLM query the Thalassa app makes, building a personalized knowledge base over time.
- When the boat is online, Thalassa routes hard questions to cloud LLMs (better quality) and Bosun caches the answers locally.
- When the boat is offline, Bosun handles everything — diagnostics, navigation queries, regulation lookups, weather decoding, conversation — at 1–2 second response times.

The end state: by year two of ownership, Bosun knows your engine's quirks, your sail configuration, your usual cruising waters, your installed electronics, the parts you've replaced, the questions you've asked. No cloud LLM can ever match that depth without also having spent two years on YOUR boat. The competitive position is asymptotically unreachable.

---

## Architecture — the six pieces

### 1. Base model

- **Phi-3 mini (3.8B params)** or **Llama 3.2 3B** — both are capable small base models with strong instruction-following.
- Quantized to **Q4_K_M** (4-bit) for ~3-4 GB on-disk weight, ~4-5 GB peak RAM during inference.
- Runs comfortably on a Raspberry Pi 5 8 GB with headroom for the existing pi-cache services.
- Inference engine: `llama.cpp` (mature, well-optimized for ARM, broad community support).

**Why not a larger model?** Pi 5 can technically run Llama 3.1 8B at 1-3 tokens/sec, but the UX is dreadful. The 1-3B param tier delivers conversational latency (5-15 tok/sec) and is good enough once domain-fine-tuned. Quality gap closes with corpus quality, not param count.

**Why not Hailo AI HAT?** The Hailo accelerator is optimized for convolutional vision networks, not transformer/LLM workloads. It would be a category mistake to assume it accelerates LLM inference. Use the AI HAT for a separate vision pipeline (foredeck collision-avoidance camera, sky-camera cloud classification, AIS visual cross-reference) running in parallel.

### 2. Corpus

The single biggest project lift. This is what makes Bosun a marine specialist rather than a generic small model.

**Tier 1 — public domain / open access:**

- ColRegs (full text, with national variants: USCG, AMSA, MCA, MSA Singapore, etc.)
- USCG Coast Pilots (all volumes)
- UKHO Admiralty Tide Tables prose sections (the data tables themselves go elsewhere)
- NOAA marine forecast products and decoding guides
- BoM Australia marine forecast structure docs
- AMSA bulletins
- IMO publications in the public domain
- Royal Yachting Association free publications

**Tier 2 — manufacturer manuals (free for download, sometimes requires consent for redistribution):**

- Engine manuals: Yanmar, Volvo Penta, Beta Marine, Westerbeke, Perkins
- Deck gear: Lewmar, Selden, Andersen, Spinlock, Harken
- Electronics: Raymarine, Garmin, B&G, Furuno, Simrad
- Watermakers, refrigeration, autopilots, windlasses, life rafts, EPIRBs

Many of these are downloadable PDFs. Re-distribution rights for fine-tuning are a legal question — but training a model on legally-acquired documents for personal/commercial use of the model is generally defensible under fair use, especially when the model paraphrases rather than reproduces.

**Tier 3 — licensed (paid, requires negotiation):**

- _Royce's Sailing Illustrated_ (the bible of small-craft seamanship)
- _Chapman Piloting & Seamanship_
- _Heavy Weather Sailing_ (Adlard Coles)
- _Storm Tactics Handbook_ (Pardey)
- _The Annapolis Book of Seamanship_ (Rousmaniere)
- Reed's Nautical Almanac (technical sections)

These would need direct publisher licensing — likely $5k–25k each, depending on terms. Some authors may be open to commercial licensing for AI training; others won't be.

**Tier 4 — community-sourced (fair use with attribution):**

- Cruisers Forum (selected high-value threads)
- SailNet archives
- YBW (Yachting & Boating World) forums
- Reddit r/sailing high-quality threads

These are fair-use-defensible if the model paraphrases rather than reproduces, and proper attribution is shown when the user surfaces a relevant answer.

### 3. Q&A synthesis pipeline

Fine-tuning needs Q&A pairs, not raw documents.

1. **Chunk the corpus** into ~500-token semantic units (one anchor knot description, one engine maintenance procedure, etc.).
2. **For each chunk, generate 3-5 Q&A pairs** using Claude (best at this task) or GPT-5. Cost: ~$0.001-0.005 per pair at frontier-model rates.
3. **Target 30-50k synthesized pairs** for the initial training run.
4. **Human validation** — sample 500-1000 pairs (~3%) for manual review. A skipper / rigger / marine engineer reviews for accuracy. Bad pairs filtered out.
5. **Categorize** by domain (engines / rigging / electronics / nav / regs / weather / safety) for stratified evaluation.
6. **Synthesize multi-turn conversations** for ~20% of the dataset — Bosun needs to handle "I tried that, what next?" follow-ups, not just one-shots.

Estimated cost: $200-500 in cloud LLM API calls + ~80 hours of human review time.

### 4. Fine-tuning

- **LoRA (Low-Rank Adaptation)** on the base model. Avoids the prohibitive cost of full fine-tuning, preserves base model capabilities.
- Cloud GPU rental: AWS p4d.24xlarge or Lambda Labs H100 — $200-500 per major training run.
- Training time: ~6-12 hours per run.
- Iterate: train, evaluate against held-out test set, identify gaps, add corpus, re-train. Typically 5-8 iterations to get to v0.1 production quality.

### 5. Pi runtime

- `llama.cpp` server mode, exposed on the existing pi-cache port range.
- Quantized model file (~3-4 GB) ships with the pi-cache install image.
- API surface mimics the OpenAI Chat Completions format so the Thalassa app can use a single client wrapper for both cloud and local routing.
- Memory budget on Pi 5 8 GB: ~5 GB for Bosun + ~2 GB for existing pi-cache services + ~1 GB OS overhead = comfortable fit.
- Performance target: 5-10 tokens/sec for short responses, 1-2 second time-to-first-token.

### 6. RAG layer + personalization loop

- **Vector store**: SQLite + sqlite-vss extension. No need for Pinecone or a hosted vector DB — keeps everything on the Pi.
- **Embedding model**: a small sentence-transformer (e.g., bge-small) running locally — ~150ms per embedding on Pi CPU, fine for the volume.
- **Initial RAG corpus**: same as the fine-tuning corpus (marine reference texts).
- **Per-vessel additions**:
    - User uploads their boat's specific manuals — Bosun indexes them.
    - Service log entries get embedded — "Replaced fuel injector pump, March 2026" becomes a retrievable fact.
    - Cloud LLM Q&A logs get embedded — every question Thalassa asks Claude/GPT-5/Gemini, the answer gets stored on the Pi.
- **Routing logic**:
    - Online + simple query → cloud LLM (best quality, cache result locally)
    - Online + complex query → cloud LLM with extended thinking, cache result
    - Offline + any query → Bosun + RAG over the vessel's local index
    - Offline + Bosun unsure → flag for re-query when comms restored
- **Compounding effect**: by month 6 of ownership, the per-vessel RAG index has hundreds of cached cloud-quality answers covering this skipper's specific use cases. The local model effectively "remembers" what the cloud once said.

---

## Build plan (months from project start)

| Phase                            | Duration  | Deliverable                                                              |
| -------------------------------- | --------- | ------------------------------------------------------------------------ |
| 0. Corpus assembly               | 4-6 weeks | Cleaned, deduplicated, organized marine corpus (~500 MB structured text) |
| 1. Q&A synthesis                 | 2-3 weeks | 30-50k validated Q&A pairs                                               |
| 2. v0.1 fine-tune                | 2 weeks   | First trained model, internal evaluation                                 |
| 3. Pi runtime engineering        | 3-4 weeks | Model packaged, llama.cpp server integrated, API surface complete        |
| 4. RAG layer                     | 2-3 weeks | Vector store running, vessel-specific indexing pipeline                  |
| 5. Routing layer in Thalassa app | 2 weeks   | Online/offline switch, cache writes to Pi                                |
| 6. Internal beta (live boats)    | 4-6 weeks | 5-10 friendly skippers running Bosun on their Pi, feedback loop          |
| 7. Iteration + corpus expansion  | 4 weeks   | Address gaps surfaced in beta, retrain                                   |
| 8. v1.0 release                  | 2 weeks   | Production launch                                                        |

**Total: ~6-7 months from start to v1.0 production.**

---

## Cost estimate (AUD)

| Line item                                            | Estimate     |
| ---------------------------------------------------- | ------------ |
| Corpus assembly labor (1 person, 6 weeks)            | $15-25k      |
| Tier 3 corpus licensing (classic texts)              | $20-50k      |
| Q&A synthesis cloud LLM API calls                    | $1k          |
| Human Q&A validation (rigger/skipper consultant)     | $3-5k        |
| Fine-tuning compute (~10 training runs at $300 each) | $3k          |
| Pi runtime engineering (1 person, 4 weeks)           | $10-15k      |
| RAG layer engineering (1 person, 3 weeks)            | $7-10k       |
| App-side routing engineering (1 person, 2 weeks)     | $5-8k        |
| Internal beta coordination + iteration               | $5-10k       |
| Contingency (15%)                                    | $10-20k      |
| **Total**                                            | **$80-150k** |

The single biggest variable is corpus licensing. If the strategy is "Tier 1 + Tier 2 + Tier 4 only, skip Tier 3 classics", the budget halves. The model quality drops modestly — the classics are great training data but the public-domain corpus alone is enough for a v1 that's already category-leading.

---

## Strategic positioning

### Why now (post-TestFlight)?

Building Bosun BEFORE TestFlight is the classic AI startup mistake — building moats around hypothetical user needs. Build with users first, then build the moat around what they actually do.

The right sequence:

1. Ship Thalassa to TestFlight beta (Q2 2026)
2. Get 6-8 weeks of real skipper feedback
3. Identify the AI use cases that beta testers actually want and use
4. **Then** start Bosun, with a corpus aimed at the validated need-set

### Competitive defensibility

| Competitor         | Time to copy core Thalassa features | Time to copy Bosun                                               |
| ------------------ | ----------------------------------- | ---------------------------------------------------------------- |
| PredictWind        | 12-18 months                        | 24-36 months (no Pi infrastructure)                              |
| Orca               | 9-12 months                         | 18-24 months (their hardware doesn't have the LLM-class compute) |
| Savvy Navvy        | 6-12 months                         | Won't try; not their thesis                                      |
| Navionics (Garmin) | Will not copy                       | Will not copy                                                    |
| Apple Weather      | 6-9 months for marine features      | Won't enter the segment                                          |

Bosun is the only Thalassa moat that is structurally hard for any competitor to close, because it requires:

- A deployed Pi infrastructure (years of customer hardware deployment)
- A curated marine corpus (months of corpus-build labor)
- A trained model (months of iteration)
- The personalization data flywheel (years of per-vessel accumulation)

By the time a competitor decides to build their version, Thalassa fleets have a 2-3 year corpus head start that's structurally uncatchable.

### Revenue / product positioning

Bosun is not a separate product. It's the headline feature of Thalassa v2.0 — included in the existing Skipper tier ($149/yr). The economics work because:

- Marginal AI cost per skipper trends to ~$0 (no per-query API fees once the local model is running)
- Hardware cost is borne by the skipper (Pi 5 + AI HAT, ~$200 one-time)
- Differentiation justifies maintaining or raising the Skipper tier price

Optional future SKU: "Bosun Pro" at +$50/yr for crews/charters wanting access to fleet-wide insights, multi-vessel personalization sync, etc.

---

## Risks & open questions

1. **Corpus licensing legality.** Training on copyrighted manuals and books is legally murky. Consult IP counsel before committing to Tier 3 licensing or fair-use claims on Tier 2.

2. **Model quality vs. cloud baseline.** A 3B param fine-tuned model will not match Claude 4.7 / GPT-5 on hard reasoning. The pitch must be "good enough offline + better personalization", not "we replaced Claude". Set expectations honestly with users.

3. **Pi resource ceiling.** If the LLM consumes 5 GB RAM on the Pi 5 8 GB, the existing pi-cache services + future features have ~3 GB to share. Pi 5 16 GB (when widely available) softens this. Worth requiring 16 GB Pi for Bosun at launch.

4. **Update / re-train cadence.** Marine knowledge isn't static — new gear, new regulations, new techniques. A re-train cadence of every 6 months is realistic; faster gets expensive in human review.

5. **Hallucination risk in safety-critical contexts.** A wrong answer about engine starting procedure is annoying. A wrong answer about heaving-to in a storm could kill someone. Bosun MUST flag low-confidence answers and refuse to give safety-critical advice without explicit citation back to source material in the corpus.

6. **Personalization privacy guardrails.** The per-vessel local data is private by design — never leaves the Pi. But the architecture must be airtight against accidental telemetry leaks, especially as multi-vessel sync features are added.

---

## Next concrete steps (when project starts, post-TestFlight)

1. Engage IP counsel on corpus licensing (week 1)
2. Hire / contract corpus assembly lead (week 1)
3. Recruit 5-10 friendly-skipper beta cohort with Pi infrastructure (week 1-2)
4. Begin Tier 1 + Tier 2 corpus assembly in parallel with legal review (week 1-6)
5. Begin Q&A synthesis as soon as corpus is deduplicated (week 4-7)
6. First fine-tune run by end of week 9
7. Pi runtime engineering in parallel from week 5

---

## Closing note

Bosun is the difference between Thalassa being "the best marine app of 2026" and Thalassa being "the company that defined what marine software became in the 2030s."

The product depth Thalassa has built so far is necessary but not sufficient. The Pi cache infrastructure that's been deployed is a strategic asset that nobody else in the space has. Project Bosun is what turns that asset from "offline weather data" into "an AI sailor that lives on every Thalassa boat."

Park it for now. Ship TestFlight. Get real users. Then build the moat that nobody can cross.

---

_Drafted in conversation with Claude (Anthropic) on April 26, 2026, as part of the pre-TestFlight QA cycle. Lives at `docs/BOSUN_AI_SPEC.md` in the Thalassa repo._
