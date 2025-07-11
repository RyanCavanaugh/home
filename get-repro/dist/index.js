#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const axios_1 = __importDefault(require("axios"));
const zod_1 = require("zod");
const openai_1 = __importDefault(require("openai"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Zod schema for extracted files
const FileContentSchema = zod_1.z.object({
    filename: zod_1.z.string(),
    content: zod_1.z.string(),
});
const ExtractedFilesSchema = zod_1.z.object({
    files: zod_1.z.array(FileContentSchema),
});
// GitHub Issue response schema
const GitHubIssueSchema = zod_1.z.object({
    body: zod_1.z.string().nullable(),
    title: zod_1.z.string(),
    number: zod_1.z.number(),
});
class GetReproError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GetReproError';
    }
}
async function fetchGitHubIssue(issueUrl) {
    // Parse the GitHub URL to extract owner, repo, and issue number
    const urlMatch = issueUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);
    if (!urlMatch) {
        throw new GetReproError('Invalid GitHub issue URL format. Expected: https://github.com/owner/repo/issues/123');
    }
    const [, owner, repo, issueNumber] = urlMatch;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
    // Set up headers with optional GitHub token for higher rate limits
    const headers = {
        'User-Agent': 'get-repro-cli',
    };
    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
        headers['Authorization'] = `token ${githubToken}`;
    }
    try {
        console.log(`Fetching issue data from: ${apiUrl}`);
        const response = await axios_1.default.get(apiUrl, { headers });
        const issue = GitHubIssueSchema.parse(response.data);
        if (!issue.body) {
            throw new GetReproError('Issue has no body content');
        }
        return {
            body: issue.body,
            title: issue.title,
            number: issue.number,
        };
    }
    catch (error) {
        if (axios_1.default.isAxiosError(error)) {
            if (error.response?.status === 404) {
                throw new GetReproError('GitHub issue not found. Please check the URL.');
            }
            if (error.response?.status === 403) {
                throw new GetReproError('GitHub API rate limit exceeded. Set GITHUB_TOKEN environment variable for higher limits.');
            }
            throw new GetReproError(`Failed to fetch GitHub issue: ${error.message}`);
        }
        throw error;
    }
}
async function extractFilesWithAzureAI(issueBody) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4';
    // Mock mode for testing without Azure AI
    if (process.env.MOCK_AI === 'true') {
        console.log('Running in mock mode (set MOCK_AI=false to use real Azure AI)...');
        return extractFilesMockMode(issueBody);
    }
    if (!endpoint || !apiKey) {
        throw new GetReproError('Azure OpenAI credentials not found. Please set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY environment variables. Alternatively, set MOCK_AI=true for testing.');
    }
    const client = new openai_1.default({
        apiKey: apiKey,
        baseURL: `${endpoint}/openai/deployments/${deploymentName}`,
        defaultQuery: { 'api-version': '2024-08-01-preview' },
        defaultHeaders: {
            'api-key': apiKey,
        },
    });
    const systemPrompt = `You are a helpful assistant that extracts file contents from GitHub issue descriptions. 

Look for file contents in the text that might be:
1. Marked with // @filename directives followed by code
2. Described in prose with filenames and their contents
3. Code blocks with implied filenames
4. Any other way files and their contents are presented

Extract each file with its filename and full content. Return ONLY a valid JSON object with this exact structure:
{
  "files": [
    {
      "filename": "example.ts", 
      "content": "// file content here"
    }
  ]
}

If no files are found, return: {"files": []}

IMPORTANT: 
- Return only valid JSON, no markdown formatting or additional text
- Include complete file contents, not truncated versions
- Sanitize filenames to be safe (no directory traversal like ../)
- If filename is not explicitly given, infer a reasonable one based on content/context`;
    const userPrompt = `Please extract any file contents from this GitHub issue:\n\n${issueBody}`;
    try {
        console.log('Analyzing issue content with Azure AI...');
        const response = await client.chat.completions.create({
            model: deploymentName,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: 4000,
            temperature: 0.1,
        });
        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new GetReproError('No response from Azure AI');
        }
        // Parse the JSON response
        let jsonResponse;
        try {
            jsonResponse = JSON.parse(content);
        }
        catch (error) {
            throw new GetReproError(`Invalid JSON response from Azure AI: ${content}`);
        }
        // Validate with Zod schema
        const extractedFiles = ExtractedFilesSchema.parse(jsonResponse);
        return extractedFiles;
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            throw new GetReproError(`Invalid response format from Azure AI: ${error.message}`);
        }
        throw error;
    }
}
// Mock function for testing without Azure AI
function extractFilesMockMode(issueBody) {
    const files = [];
    // Simple pattern matching for basic file extraction
    // Look for @filename directives
    const filenameMatches = issueBody.match(/\/\/\s*@filename:?\s*([^\n\r]+)/gi);
    if (filenameMatches) {
        filenameMatches.forEach((match, index) => {
            const filename = match.replace(/\/\/\s*@filename:?\s*/i, '').trim();
            // Try to find the code block after this directive
            const remainingText = issueBody.substring(issueBody.indexOf(match) + match.length);
            const codeBlockMatch = remainingText.match(/```[\s\S]*?\n([\s\S]*?)```/);
            if (codeBlockMatch) {
                files.push({
                    filename: filename,
                    content: codeBlockMatch[1].trim()
                });
            }
        });
    }
    // If no @filename directives found, look for generic code blocks
    if (files.length === 0) {
        const codeBlocks = issueBody.match(/```(?:\w+)?\n([\s\S]*?)```/g);
        if (codeBlocks) {
            codeBlocks.forEach((block, index) => {
                const content = block.replace(/```(?:\w+)?\n/, '').replace(/```$/, '').trim();
                if (content) {
                    const extension = block.match(/```(\w+)/)?.[1] || 'txt';
                    files.push({
                        filename: `extracted_${index + 1}.${extension}`,
                        content: content
                    });
                }
            });
        }
    }
    return { files };
}
function sanitizeFilename(filename) {
    // Remove directory traversal attempts
    const sanitized = filename
        .replace(/\.\./g, '') // Remove ..
        .replace(/^\/+/, '') // Remove leading slashes
        .replace(/[<>:"|?*]/g, '_') // Replace invalid characters
        .replace(/\s+/g, '_'); // Replace spaces with underscores
    // Ensure we have a filename
    if (!sanitized || sanitized === '.') {
        return 'untitled.txt';
    }
    return sanitized;
}
async function writeFilesToDisk(files, outputDir = '.') {
    const writtenFiles = [];
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    for (const file of files) {
        const sanitizedFilename = sanitizeFilename(file.filename);
        const fullPath = path.join(outputDir, sanitizedFilename);
        // Additional safety check to ensure we're not writing outside the target directory
        const resolvedPath = path.resolve(fullPath);
        const resolvedOutputDir = path.resolve(outputDir);
        if (!resolvedPath.startsWith(resolvedOutputDir)) {
            console.warn(`Skipping potentially unsafe file path: ${file.filename}`);
            continue;
        }
        try {
            fs.writeFileSync(fullPath, file.content, 'utf8');
            writtenFiles.push(sanitizedFilename);
            console.log(`✓ Wrote: ${sanitizedFilename}`);
        }
        catch (error) {
            console.error(`✗ Failed to write ${sanitizedFilename}: ${error}`);
        }
    }
    return writtenFiles;
}
async function main() {
    const program = new commander_1.Command();
    program
        .name('get-repro')
        .description('Extract file contents from GitHub issues using Azure AI')
        .version('1.0.0')
        .argument('<github-url>', 'GitHub issue URL (e.g., https://github.com/microsoft/TypeScript/issues/12345)')
        .option('-o, --output <dir>', 'Output directory for extracted files', '.')
        .action(async (githubUrl, options) => {
        try {
            // Fetch GitHub issue
            const issue = await fetchGitHubIssue(githubUrl);
            console.log(`Processing issue #${issue.number}: ${issue.title}`);
            // Extract files with Azure AI
            const extractedFiles = await extractFilesWithAzureAI(issue.body);
            if (extractedFiles.files.length === 0) {
                console.log('No files found in the issue.');
                return;
            }
            console.log(`Found ${extractedFiles.files.length} file(s):`);
            extractedFiles.files.forEach(file => {
                console.log(`  - ${file.filename}`);
            });
            // Write files to disk
            const writtenFiles = await writeFilesToDisk(extractedFiles.files, options.output);
            console.log(`\nSuccessfully extracted ${writtenFiles.length} file(s):`);
            writtenFiles.forEach(filename => {
                console.log(`  ✓ ${filename}`);
            });
        }
        catch (error) {
            if (error instanceof GetReproError) {
                console.error(`Error: ${error.message}`);
                process.exit(1);
            }
            else {
                console.error(`Unexpected error: ${error}`);
                process.exit(1);
            }
        }
    });
    program.parse();
}
if (require.main === module) {
    main().catch(console.error);
}
//# sourceMappingURL=index.js.map