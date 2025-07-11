#!/bin/bash

# Demo script for get-repro CLI utility

echo "=== get-repro CLI Demo ==="
echo ""

echo "This demo shows how the get-repro CLI utility works."
echo "It extracts file contents from GitHub issues using AI analysis."
echo ""

echo "Usage examples:"
echo "  Basic usage:              get-repro https://github.com/microsoft/TypeScript/issues/12345"
echo "  With output directory:    get-repro https://github.com/owner/repo/issues/123 -o ./extracted"
echo "  Show help:               get-repro --help"
echo ""

echo "Required environment variables for full functionality:"
echo "  AZURE_OPENAI_ENDPOINT     - Your Azure OpenAI resource endpoint"
echo "  AZURE_OPENAI_API_KEY      - Your Azure OpenAI API key"
echo "  AZURE_OPENAI_DEPLOYMENT_NAME  - Your model deployment name (optional, defaults to 'gpt-4')"
echo ""

echo "Optional environment variables:"
echo "  GITHUB_TOKEN              - GitHub personal access token (for higher API rate limits)"
echo "  MOCK_AI=true              - Use mock mode for testing without Azure AI"
echo ""

echo "Example with mock mode (for testing):"
echo "  MOCK_AI=true get-repro https://github.com/microsoft/TypeScript/issues/12345"
echo ""

echo "The tool will:"
echo "  1. Fetch the GitHub issue content"
echo "  2. Analyze it with Azure AI (or mock extraction)"
echo "  3. Extract file contents with proper sanitization"
echo "  4. Write files to disk in the specified directory"
echo "  5. Report the list of successfully extracted files"
echo ""

echo "Files are written with sanitized names to prevent directory traversal attacks."
echo "All paths are validated to ensure they stay within the target directory."