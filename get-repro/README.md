# get-repro

A collection of CLI utilities for working with GitHub issues and TypeScript validation using Azure AI.

## Tools

### get-repro
A CLI utility that extracts file contents from GitHub issues using Azure AI.

### repro-check  
A TypeScript issue reproduction validator that analyzes bugs and determines their current status.

## Features

- Fetches GitHub issue content via the GitHub API
- Uses Azure OpenAI to intelligently extract file contents from issue descriptions
- Handles various formats including `// @filename` directives, prose descriptions, and code blocks
- Sanitizes file paths for security
- Writes extracted files to disk
- Provides structured output validation with Zod schemas

## Installation

```bash
npm install
npm run build
```

## Usage

### get-repro

```bash
# Basic usage
get-repro https://github.com/microsoft/TypeScript/issues/12345

# Specify output directory
get-repro https://github.com/microsoft/TypeScript/issues/12345 -o ./extracted-files

# Or using npm script
npm run dev -- https://github.com/microsoft/TypeScript/issues/12345
```

### repro-check

Analyze and validate TypeScript issue reproduction status:

```bash
# Analyze an issue
repro-check analyze microsoft/TypeScript#9998

# Generate markdown comment from analysis
repro-check post analysis-result.json
```

**Analyze Mode:**
- Fetches GitHub issue and all comments
- Uses AI to categorize the issue type
- For testable issues: extracts files and runs TypeScript compiler
- Outputs structured JSON with reproduction status

**Post Mode:**
- Reads analysis JSON output
- Generates formatted markdown comments for GitHub
- Provides clear recommendations for issue management

**Example workflow:**
```bash
# Analyze issue and save results
repro-check analyze microsoft/TypeScript#12345 > result.json

# Generate comment for posting
repro-check post result.json
```

## Configuration

You need to set up Azure OpenAI credentials as environment variables:

```bash
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"
export AZURE_OPENAI_API_KEY="your-api-key"
export AZURE_OPENAI_DEPLOYMENT_NAME="gpt-4"  # Optional, defaults to 'gpt-4'
```

### Optional Environment Variables

```bash
# GitHub token for higher API rate limits (recommended)
export GITHUB_TOKEN="your-github-token"

# Enable mock mode for testing without Azure AI
export MOCK_AI="true"
```

### Testing without Azure AI

For testing or development purposes, you can use mock mode:

```bash
MOCK_AI=true get-repro https://github.com/microsoft/TypeScript/issues/12345
```

Mock mode uses simple pattern matching to extract code blocks and `// @filename` directives without requiring Azure AI credentials.

## How it works

1. **Parse GitHub URL**: Extracts owner, repository, and issue number from the provided URL
2. **Fetch Issue Data**: Uses the GitHub API to retrieve issue content
3. **AI Analysis**: Sends the issue body to Azure OpenAI to identify and extract file contents
4. **File Extraction**: Parses the AI response using Zod schema validation
5. **Path Sanitization**: Ensures all file paths are safe and cannot escape the target directory
6. **File Writing**: Writes extracted files to the specified directory

## Example

```bash
$ get-repro https://github.com/microsoft/TypeScript/issues/12345

Fetching issue data from: https://api.github.com/repos/microsoft/TypeScript/issues/12345
Processing issue #12345: Type error in generic function
Analyzing issue content with Azure AI...
Found 2 file(s):
  - example.ts
  - test.js
✓ Wrote: example.ts
✓ Wrote: test.js

Successfully extracted 2 file(s):
  ✓ example.ts
  ✓ test.js
```

## Supported File Formats

The AI can extract files from various formats commonly found in GitHub issues:

- `// @filename` directives followed by code blocks
- Prose descriptions with explicit filenames and content
- Code blocks with implied or contextual filenames
- Mixed content with multiple files

## Security

- All file paths are sanitized to prevent directory traversal attacks
- Files cannot be written outside the specified output directory
- Invalid characters in filenames are replaced with safe alternatives

## Error Handling

The tool provides clear error messages for common issues:
- Invalid GitHub URLs
- Missing or inaccessible GitHub issues
- Missing Azure OpenAI credentials
- AI response parsing errors
- File writing permissions

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run development version
npm run dev -- <github-url>
```

## Dependencies

- `typescript`: TypeScript compiler
- `commander`: CLI framework
- `axios`: HTTP client for GitHub API
- `openai`: OpenAI/Azure OpenAI client
- `zod`: Schema validation
- `@types/node`: Node.js type definitions