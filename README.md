# Maana Q Standalone Workspace Service Host

## Local build and development

```bash
yarn install
yarn run dev
```

## Local docker build and execution

```bash
yarn run docker-build
yarn run docker-run
```

## Deploy

Use the Maana GraphQL CLI commands to deploy to your Maana Kubernetes cluster:

```bash
# Install the GraphQL CLI and Maana commands
npm i -g graphql-cli graphql-cli-maana

# Use the Maana deployment command and follow the interactive prompts
gql mdeploy
```
