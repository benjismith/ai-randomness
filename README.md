# AI Randomness

Experiments exploring how language models handle randomness. We asked Claude to "pick a name at random" 37,500 times across five models and dozens of prompt variations, then analyzed the results.

The full writeup is published here: [Marcus, Marcus, Marcus!](https://machinecreativity.substack.com/p/marcus-marcus-marcus-ai-randomness)

Key findings:

- The most common male name was "Marcus", chosen 4,367 times (23.6%)
- Opus 4.5 returned "Marcus" 100 out of 100 times with the simple prompt
- Nine parameter combinations produced zero entropy — perfectly deterministic output
- Elaborate prompts doubled unique names but introduced different biases
- Random word seeds were more effective than random noise at increasing diversity

## Setup

```bash
npm install
```

To run experiments, you'll need an Anthropic API key in a `.env` file:

```
ANTHROPIC_API_KEY=your-key-here
```

## Running

Run the experiment (calls the Anthropic API — this costs real money):

```bash
npm run experiment:random-names
```

Run the analysis on collected results:

```bash
npm run analysis:random-names
```

## Results

The `output/` directory contains:

- **`random-names.tar.gz`** — All 37,500 individual JSON responses, archived. Extract with `tar xzf output/random-names.tar.gz -C output/` to get the individual files.
- **`random-names-analysis.json`** — Full statistical analysis including per-model breakdowns, entropy calculations, and cross-parameter comparisons.
- **`actual-costs.json`** — Real API costs from running the experiment ($27.58 total).
