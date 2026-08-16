# Model Provider Findings

## GitHub Models

The official GitHub Models documentation states that GitHub Models was fully retired on July 30, 2026. The playground, model catalog, inference API, and BYOK are no longer available. GitHub Models therefore cannot be used as the stronger runtime provider for Sol.

Source: https://docs.github.com/github-models

## Gemini API

The official Gemini documentation states that the Gemini API supports text generation, structured outputs, function calling, and agentic workflows. The current documentation lists Gemini 3.1 Pro as the strongest reasoning-oriented model and Gemini 3.7 Flash as the latest capable Flash model for complex coding, agentic workflows, and multi-step execution. The API exposes a model-list endpoint at `https://generativelanguage.googleapis.com/v1beta/models` and content-generation APIs.

Sources:
- https://ai.google.dev/gemini-api/docs
- https://ai.google.dev/api/models

## Integration decision

Do not attempt GitHub Models integration because the service is retired. If Gemini access is enabled in the runner, use a secret-backed provider adapter with no key in source, logs, or public telemetry. Keep the provider hot-updatable and record only the provider/model identifier and request outcome in the cognition log. The verifier, not the model, remains the authority for legal actions and world-state success.
