#!/usr/bin/env node

import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import { Command } from 'commander';
import axios from 'axios';
import { z } from 'zod';
import { AzureOpenAI } from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { zodResponseFormat } from "openai/helpers/zod";

// Zod schemas for analyze mode outputs
const TestableReproSchema = z.object({
  still_repros: z.boolean(),
  files: z.record(z.string(), z.string()),
  expected: z.string(),
  actual: z.string()
});

const CannotReproSchema = z.object({
  cannot_repro: z.string()
});

const MootIssueSchema = z.object({
  moot: z.string()
});

const AnalyzeResultSchema = z.union([
  TestableReproSchema,
  CannotReproSchema,
  MootIssueSchema
]);

type AnalyzeResult = z.infer<typeof AnalyzeResultSchema>;

// GitHub API schemas
const GitHubIssueSchema = z.object({
  body: z.string().nullable(),
  title: z.string(),
  number: z.number(),
  comments: z.number()
});

const GitHubCommentSchema = z.object({
  body: z.string(),
  user: z.object({
    login: z.string()
  }),
  created_at: z.string()
});

// AI categorization schema
const IssueCategorySchema = z.object({
  category: z.enum([
    "testable_with_tsc",
    "requires_language_service", 
    "performance_related",
    "deprecated_config",
    "other"
  ]),
  reasoning: z.string(),
  deprecated_features: z.array(z.string()).optional()
});

class ReproCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReproCheckError';
  }
}

async function fetchGitHubIssue(issueRef: string): Promise<{ body: string; title: string; number: number; comments: string[] }> {
  // Parse issue reference (microsoft/TypeScript#9998)
  const match = issueRef.match(/^([^\/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    throw new ReproCheckError('Invalid issue reference format. Expected: owner/repo#number');
  }

  const [, owner, repo, issueNumber] = match;
  const issueApiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
  const commentsApiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;

  // Set up headers with optional GitHub token
  const headers: any = {
    'User-Agent': 'repro-check-cli',
  };
  
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    headers['Authorization'] = `token ${githubToken}`;
  }

  try {
    console.log(`Fetching issue ${issueRef}...`);
    
    // Fetch issue data
    const issueResponse = await axios.get(issueApiUrl, { headers });
    const issue = GitHubIssueSchema.parse(issueResponse.data);

    if (!issue.body) {
      throw new ReproCheckError('Issue has no body content');
    }

    // Fetch comments if any exist
    const comments: string[] = [];
    if (issue.comments > 0) {
      console.log(`Fetching ${issue.comments} comments...`);
      const commentsResponse = await axios.get(commentsApiUrl, { headers });
      const commentsData = z.array(GitHubCommentSchema).parse(commentsResponse.data);
      
      for (const comment of commentsData) {
        comments.push(`@${comment.user.login} (${comment.created_at}):\n${comment.body}`);
      }
    }

    return {
      body: issue.body,
      title: issue.title,
      number: issue.number,
      comments
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        throw new ReproCheckError('GitHub issue not found. Please check the issue reference.');
      }
      if (error.response?.status === 403) {
        throw new ReproCheckError('GitHub API rate limit exceeded. Set GITHUB_TOKEN environment variable for higher limits.');
      }
      throw new ReproCheckError(`Failed to fetch GitHub issue: ${error.message}`);
    }
    throw error;
  }
}

async function categorizeIssueWithAI(issue: { body: string; title: string; comments: string[] }): Promise<z.infer<typeof IssueCategorySchema>> {
  const endpoint = "https://ryanca-aoai.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01-preview";
  
  const credential = new DefaultAzureCredential();
  const scope = "https://cognitiveservices.azure.com/.default";
  const azureADTokenProvider = getBearerTokenProvider(credential, scope);
  const apiVersion = "2025-01-01-preview";
  const deployment = "gpt-4o-mini";
  const options = { endpoint, azureADTokenProvider, deployment, apiVersion };

  const client = new AzureOpenAI(options);

  const systemPrompt = `You are an expert TypeScript maintainer analyzing bug reports to determine how they can be validated.

Categorize the issue into one of these categories:

1. "testable_with_tsc" - The bug can be reproduced by creating files and running the TypeScript compiler (tsc). Examples:
   - Type checking errors
   - Compilation errors  
   - Declaration file generation issues
   - Module resolution problems

2. "requires_language_service" - The bug requires the TypeScript language service (IDE features). Examples:
   - IntelliSense/autocomplete issues
   - Go-to-definition problems
   - Refactoring issues
   - Real-time error highlighting

3. "performance_related" - The bug is about compilation or runtime performance. Examples:
   - Slow compilation times
   - Memory usage issues
   - Build performance problems

4. "deprecated_config" - The bug only applies to deprecated TypeScript configurations. Examples:
   - strictNullChecks: false (or other strict flags being off)
   - SystemJS, UMD, or AMD module output
   - Target earlier than ES2015
   - Other deprecated compiler options

5. "other" - Anything else that doesn't fit the above categories

For deprecated_config issues, list the specific deprecated features involved.

Provide clear reasoning for your categorization.`;

  const issueContent = `
Title: ${issue.title}

Body: ${issue.body}

${issue.comments.length > 0 ? `Comments:\n${issue.comments.join('\n\n---\n\n')}` : 'No comments.'}
`;

  try {
    console.log('Categorizing issue with AI...');
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Please categorize this TypeScript issue:\n\n${issueContent}` }
      ],
      response_format: zodResponseFormat(IssueCategorySchema, "category")
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new ReproCheckError('No response from Azure AI for categorization');
    }

    return IssueCategorySchema.parse(JSON.parse(content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ReproCheckError(`Invalid categorization response from AI: ${error.message}`);
    }
    throw error;
  }
}

async function extractTestFilesWithAI(issueContent: string): Promise<{ files: Record<string, string> }> {
  const endpoint = "https://ryanca-aoai.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01-preview";
  
  const credential = new DefaultAzureCredential();
  const scope = "https://cognitiveservices.azure.com/.default";
  const azureADTokenProvider = getBearerTokenProvider(credential, scope);
  const apiVersion = "2025-01-01-preview";
  const deployment = "gpt-4o-mini";
  const options = { endpoint, azureADTokenProvider, deployment, apiVersion };

  const client = new AzureOpenAI(options);

  const FilesExtractionSchema = z.object({
    files: z.record(z.string(), z.string())
  });

  const systemPrompt = `You are an expert at extracting TypeScript test cases from bug reports.

Analyze the issue and extract the minimal set of files needed to reproduce the bug. Create:

1. TypeScript source files (.ts, .tsx, .d.ts) with the code that demonstrates the issue
2. A tsconfig.json file with appropriate compiler settings
3. Any other necessary files (package.json, etc.)

Guidelines:
- Keep files minimal but complete enough to reproduce the issue
- Use realistic filenames (e.g., "test.ts", "types.d.ts", "tsconfig.json")
- Include only the essential compiler options in tsconfig.json
- If the issue mentions specific compiler settings, include them
- Make sure the code is syntactically valid TypeScript

Return a JSON object where keys are filenames and values are file contents.`;

  try {
    console.log('Extracting test files with AI...');
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Extract test files from this TypeScript issue:\n\n${issueContent}` }
      ],
      response_format: zodResponseFormat(FilesExtractionSchema, "files")
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new ReproCheckError('No response from Azure AI for file extraction');
    }

    return FilesExtractionSchema.parse(JSON.parse(content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ReproCheckError(`Invalid file extraction response from AI: ${error.message}`);
    }
    throw error;
  }
}

async function runTypeScriptCompiler(tempDir: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    console.log('Running TypeScript compiler...');
    
    const tsc = spawn('tsc', ['-p', tempDir], {
      stdio: 'pipe'
    });

    let stdout = '';
    let stderr = '';

    tsc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    tsc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    tsc.on('error', (error) => {
      reject(new ReproCheckError(`Failed to spawn tsc: ${error.message}. Make sure TypeScript is installed globally.`));
    });

    tsc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0
      });
    });
  });
}

async function analyzeMode(issueRef: string): Promise<void> {
  try {
    // Fetch issue and comments
    const issue = await fetchGitHubIssue(issueRef);
    
    // Categorize the issue
    const category = await categorizeIssueWithAI(issue);
    
    let result: AnalyzeResult;

    switch (category.category) {
      case 'requires_language_service':
        result = {
          cannot_repro: "This requires a language service or other tool I can't run"
        };
        break;
        
      case 'performance_related':
        result = {
          cannot_repro: "This is a performance-related issue that cannot be validated with simple compilation"
        };
        break;
        
      case 'deprecated_config':
        const features = category.deprecated_features?.join(', ') || 'deprecated configurations';
        result = {
          moot: `This bug is only relevant under ${features}, which is deprecated`
        };
        break;
        
      case 'other':
        result = {
          cannot_repro: category.reasoning
        };
        break;
        
      case 'testable_with_tsc':
        // Extract files and test with TypeScript compiler
        const issueContent = `Title: ${issue.title}\n\nBody: ${issue.body}\n\n${issue.comments.join('\n\n')}`;
        const extracted = await extractTestFilesWithAI(issueContent);
        
        // Create temporary directory
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-check-'));
        
        try {
          // Write files to temp directory
          for (const [filename, content] of Object.entries(extracted.files)) {
            const filePath = path.join(tempDir, filename);
            fs.writeFileSync(filePath, content, 'utf8');
          }
          
          // Run TypeScript compiler
          const compileResult = await runTypeScriptCompiler(tempDir);
          
          // Analyze results to determine if bug still reproduces
          const hasErrors = compileResult.exitCode !== 0 || compileResult.stderr.trim() !== '';
          
          result = {
            still_repros: hasErrors,
            files: extracted.files,
            expected: "The code should compile without errors",
            actual: hasErrors 
              ? `Compilation failed with exit code ${compileResult.exitCode}. Stderr: ${compileResult.stderr.trim()}`
              : "Code compiled successfully"
          };
        } finally {
          // Clean up temp directory
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
        break;
        
      default:
        throw new ReproCheckError(`Unknown category: ${category.category}`);
    }

    // Output JSON to stdout
    console.log(JSON.stringify(result, null, 2));
    
  } catch (error) {
    if (error instanceof ReproCheckError) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function postMode(jsonFilePath: string): Promise<void> {
  try {
    // Read and parse the JSON file
    const jsonContent = fs.readFileSync(jsonFilePath, 'utf8');
    const result = AnalyzeResultSchema.parse(JSON.parse(jsonContent));
    
    let markdownComment: string;
    
    if ('still_repros' in result) {
      // Testable issue
      if (result.still_repros) {
        markdownComment = `## Reproduction Confirmed ✅

I was able to reproduce this issue using the following test case:

${Object.entries(result.files).map(([filename, content]) => 
  `**${filename}:**
\`\`\`${filename.endsWith('.json') ? 'json' : 'typescript'}
${content}
\`\`\``
).join('\n\n')}

**Expected:** ${result.expected}
**Actual:** ${result.actual}

This issue is still present and should remain open.`;
      } else {
        markdownComment = `## Unable to Reproduce ❌

I attempted to reproduce this issue but could not confirm it still exists.

Test case used:
${Object.entries(result.files).map(([filename, content]) => 
  `**${filename}:**
\`\`\`${filename.endsWith('.json') ? 'json' : 'typescript'}
${content}
\`\`\``
).join('\n\n')}

**Expected:** ${result.expected}
**Actual:** ${result.actual}

This issue may have been fixed in a recent version. Consider closing unless there are additional reproduction steps.`;
      }
    } else if ('cannot_repro' in result) {
      markdownComment = `## Cannot Validate ⚠️

${result.cannot_repro}

This issue cannot be automatically validated and requires manual review.`;
    } else if ('moot' in result) {
      markdownComment = `## Issue No Longer Relevant 🚫

${result.moot}

This issue is based on deprecated functionality and is no longer relevant. Closing as outdated.`;
    } else {
      throw new ReproCheckError('Invalid result format in JSON file');
    }
    
    console.log(markdownComment);
    
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error(`Error: Invalid JSON format in file: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof ReproCheckError) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function main() {
  const program = new Command();

  program
    .name('repro-check')
    .description('TypeScript issue reproduction validator')
    .version('1.0.0');

  program
    .command('analyze')
    .description('Analyze a TypeScript issue for reproduction status')
    .argument('<issue-ref>', 'GitHub issue reference (e.g., microsoft/TypeScript#9998)')
    .action(async (issueRef: string) => {
      await analyzeMode(issueRef);
    });

  program
    .command('post')
    .description('Generate markdown comment from analysis results')
    .argument('<json-file>', 'JSON file from analyze command output')
    .action(async (jsonFile: string) => {
      await postMode(jsonFile);
    });

  program.parse();
}

if (require.main === module) {
  main().catch(console.error);
}