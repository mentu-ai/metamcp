# Prompt Regression Fixtures

These fixtures are deliberately model-agnostic. They describe the behaviors a production agent should preserve when MetaMCP fronts business tools on Cloud Run.

Each fixture includes:

- `prompt`: the user request to replay.
- `expected_route`: the MetaMCP tool path that should be selected.
- `expected_controls`: security, observability, and evidence requirements.
- `failure_modes`: regressions that should block release.

Use them as seed cases for ADK evaluation, prompt regression suites, or CI checks around tool-routing changes.
