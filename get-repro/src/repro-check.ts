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
  bug_is_present: z.union([z.literal("yes"), z.literal("no"), z.literal("can't tell")]),
  files: z.array(z.object({
    filename: z.string(),
    content: z.string()
  })),
  user_reported_behavior: z.string(),
  expected_behavior: z.string(),
  current_observed_behavior: z.string(),
  command_line: z.string(),
  tsc_version: z.string(),
  compiler_output: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number()
  }),
  reasoning: z.string()
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
  deprecated_features: z.array(z.string())
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
  const endpoint = "https://ryanca-aoai.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview";
  
  const credential = new DefaultAzureCredential();
  const scope = "https://cognitiveservices.azure.com/.default";
  const azureADTokenProvider = getBearerTokenProvider(credential, scope);
  const apiVersion = "2025-01-01-preview";
  const deployment = "gpt-4o";
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

5. "other" - Anything else that doesn't fit the above categories

Old typescript versions are NOT deprecated. Ignore comments claiming an issue is fixed; we're here to validate those comments.

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
      model: "gpt-4o",
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

async function extractTestFilesWithAI(issueContent: string): Promise<{ files: Array<{ filename: string; content: string }>; tsc_flags: string[] }> {
  const endpoint = "https://ryanca-aoai.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview";
  
  const credential = new DefaultAzureCredential();
  const scope = "https://cognitiveservices.azure.com/.default";
  const azureADTokenProvider = getBearerTokenProvider(credential, scope);
  const apiVersion = "2025-01-01-preview";
  const deployment = "gpt-4o";
  const options = { endpoint, azureADTokenProvider, deployment, apiVersion };

  const client = new AzureOpenAI(options);

  const FilesExtractionSchema = z.object({
    files: z.array(z.object({
      filename: z.string(),
      content: z.string()
    })),
    tsc_flags: z.array(z.string())
  });

  const systemPrompt = `You are an expert at extracting TypeScript test cases from bug reports.

Analyze the issue and extract the minimal set of files needed to reproduce the bug. Create:

1. TypeScript source files (.ts, .tsx, .d.ts) with the code that demonstrates the issue
2. A tsconfig.json file with appropriate compiler settings
3. Any other necessary files (package.json, etc.)
4. Any additional tsc command line flags mentioned in the issue

Guidelines:
- Keep files minimal but complete enough to reproduce the issue
- Use realistic filenames (e.g., "test.ts", "types.d.ts", "tsconfig.json")
- Include only the essential compiler options in tsconfig.json
- If the issue mentions specific compiler settings, include them
- Make sure the code is syntactically valid TypeScript
- Extract any command line flags mentioned (e.g., --noImplicitAny, --strict, etc.)

Return a JSON object with:
- "files" array where each element has "filename" and "content" properties
- "tsc_flags" array of additional command line flags to pass to tsc`;

  try {
    console.log('Extracting test files with AI...');
    const response = await client.chat.completions.create({
      model: "gpt-4o",
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

    const parsed = FilesExtractionSchema.parse(JSON.parse(content));
    console.log(parsed);

    return {
      files: parsed.files,
      tsc_flags: parsed.tsc_flags || []
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ReproCheckError(`Invalid file extraction response from AI: ${error.message}`);
    }
    throw error;
  }
}

async function initializeTypeScriptProject(tempDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('Initializing TypeScript project...');
    
    const isWindows = process.platform === 'win32';
    const tsc = spawn('tsc', ['--init'], {
      cwd: tempDir,
      stdio: 'pipe',
      shell: isWindows
    });

    let stderr = '';

    tsc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    tsc.on('error', (error) => {
      reject(new ReproCheckError(`Failed to run tsc --init: ${error.message}. Make sure TypeScript is installed globally.`));
    });

    tsc.on('close', (code) => {
      if (code !== 0) {
        reject(new ReproCheckError(`tsc --init failed with exit code ${code}: ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

async function getTypeScriptVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const tsc = spawn('tsc', ['-v'], {
      stdio: 'pipe',
      shell: isWindows
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
      reject(new ReproCheckError(`Failed to get TypeScript version: ${error.message}`));
    });

    tsc.on('close', (code) => {
      if (code !== 0) {
        reject(new ReproCheckError(`tsc -v failed with exit code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function runTypeScriptCompiler(tempDir: string, flags: string[] = []): Promise<{ stdout: string; stderr: string; exitCode: number; generatedFiles: string[] }> {
  return new Promise((resolve, reject) => {
    console.log('Running TypeScript compiler...');
    
    // Build command arguments
    const args = ['-p', tempDir, ...flags];
    
    // On Windows, we need to use shell: true or specify the .cmd extension
    const isWindows = process.platform === 'win32';
    const tsc = spawn('tsc', args, {
      stdio: 'pipe',
      shell: isWindows
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
      // Get list of generated files
      const generatedFiles: string[] = [];
      try {
        const files = fs.readdirSync(tempDir, { recursive: true });
        for (const file of files) {
          const filePath = typeof file === 'string' ? file : file.toString();
          if (filePath.endsWith('.js') || filePath.endsWith('.d.ts') || filePath.endsWith('.js.map')) {
            const fullPath = path.join(tempDir, filePath);
            const content = fs.readFileSync(fullPath, 'utf8');
            generatedFiles.push(`${filePath}:\n${content}`);
          }
        }
      } catch (error) {
        // Ignore errors reading generated files
      }

      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
        generatedFiles
      });
    });
  });
}

async function checkReproductionWithAI(
  originalIssue: string,
  compilerOutput: { stdout: string; stderr: string; exitCode: number; generatedFiles: string[] }
): Promise<z.TypeOf<typeof ReproductionCheckSchema>> {
  const endpoint = "https://ryanca-aoai.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview";
  
  const credential = new DefaultAzureCredential();
  const scope = "https://cognitiveservices.azure.com/.default";
  const azureADTokenProvider = getBearerTokenProvider(credential, scope);
  const apiVersion = "2025-01-01-preview";
  const deployment = "gpt-4o";
  const options = { endpoint, azureADTokenProvider, deployment, apiVersion };

  const client = new AzureOpenAI(options);

  const ReproductionCheckSchema = z.object({
    reasoning: z.string(),
    user_reported_behavior: z.string(),
    expected_behavior: z.string(),
    current_observed_behavior: z.string(),
    bug_is_present: z.union([z.literal("yes"), z.literal("no"), z.literal("can't tell")]),
  });

  const systemPrompt = `You are an expert TypeScript maintainer analyzing whether a bug report has been fixed by comparing the current compiler behavior with the original bug report.

You will be given:
1. The original bug report (describing expected vs user-reported actual behavior)
2. The current TypeScript compiler output from testing the same scenario

Your task is to analyze three distinct behaviors:
- EXPECTED BEHAVIOR: What the user expected to happen (from the bug report)
- USER-REPORTED ACTUAL BEHAVIOR: What the user observed that was wrong (from the bug report)  
- CURRENT OBSERVED BEHAVIOR: What happens now when we run the same test (from compiler output)

Determine if the bug has been fixed by comparing these behaviors:

A bug is FIXED (bug_is_present: no) if:
- Current observed behavior matches the expected behavior
- The problematic user-reported behavior no longer occurs

A bug STILL EXISTS (bug_is_present: yes) if:
- Current observed behavior matches the user-reported actual behavior
- Current observed behavior differs from expected behavior in the same way as originally reported

You CAN'T TELL if:
- the repro is malformed in a way that prevents clear analysis
- the repro isn't observable based on the compiler output

Return:
- bug_is_present: true if the bug still exists, false if it has been fixed
- user_reported_behavior: the problematic behavior that the user originally reported (what was wrong)
- expected_behavior: the correct/expected behavior described in the bug report (what should happen)
- current_observed_behavior: the current behavior observed from today's compiler output (what actually happens now). DON'T READ THE CODE COMMENTS TO DETERMINE THIS!!!
- reasoning: your reasoning for the determination

Make sure to derive current_observed_behavior from empirical behavior.
You may need to reason about the presence or absence of errors or information in the error message to determine the correct result; not all bug reports are about an error being present.
If the bug report says that there SHOULD BE AN ERROR and you DO SEE THAT ERROR, then the bug is fixed.
`;

  const compilerOutputText = `
Exit Code: ${compilerOutput.exitCode}

Stdout:
${compilerOutput.stdout || '(empty)'}

Stderr:
${compilerOutput.stderr || '(empty)'}

Generated Files:
${compilerOutput.generatedFiles.length > 0 ? compilerOutput.generatedFiles.join('\n\n') : '(none)'}
`;
  console.log(compilerOutputText);

  try {
    console.log('Checking reproduction with AI...');
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze this bug report and current compiler output to determine if the bug has been fixed:

<original_bug_report>
${originalIssue}
</original_bug_report>

<current_compiler_output>
${compilerOutputText}
</current_compiler_output>

Remember that the comments in the original bug report are from WHEN THE BUG WAS FILED, so you shouldn't rely on those comments to determine truth.
Only the current compiler output is relevant as a source of truth for the current behavior.
DON'T READ COMMENTS IN THE ORIGINAL BUG REPORT TO DETERMINE CURRENT BEHAVIOR.

Please identify:
1. Expected behavior (what should happen)
2. User-reported actual behavior (what was wrong originally) 
3. Current observed behavior (what happens now)
4. Whether the current behavior indicates the bug is fixed or still exists` }
      ],
      response_format: zodResponseFormat(ReproductionCheckSchema, "reproduction_check")
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new ReproCheckError('No response from Azure AI for reproduction check');
    }

    return ReproductionCheckSchema.parse(JSON.parse(content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ReproCheckError(`Invalid reproduction check response from AI: ${error.message}`);
    }
    throw error;
  }
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
        
        // Get TypeScript version
        const tscVersion = await getTypeScriptVersion();
        
        // Build command line string
        const commandLine = `tsc -p . ${extracted.tsc_flags.join(' ')}`.trim();
        
        // Create temporary directory
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-check-'));
        
        try {
          // Initialize TypeScript project first
          await initializeTypeScriptProject(tempDir);
          
          // Write files to temp directory
          for (const file of extracted.files) {
            const filePath = path.join(tempDir, file.filename);
            const dirPath = path.dirname(filePath);
            if (!fs.existsSync(dirPath)) {
              fs.mkdirSync(dirPath, { recursive: true });
            }
            fs.writeFileSync(filePath, file.content, 'utf8');
          }
          
          // Run TypeScript compiler with extracted flags
          const compileResult = await runTypeScriptCompiler(tempDir, extracted.tsc_flags);
          
          // Use AI to analyze if the bug reproduces
          const reproductionResult = await checkReproductionWithAI(issueContent, compileResult);
          
          result = {
            bug_is_present: reproductionResult.bug_is_present,
            files: extracted.files,
            user_reported_behavior: reproductionResult.user_reported_behavior,
            expected_behavior: reproductionResult.expected_behavior,
            current_observed_behavior: reproductionResult.current_observed_behavior,
            command_line: commandLine,
            tsc_version: tscVersion,
            compiler_output: {
              stdout: compileResult.stdout,
              stderr: compileResult.stderr,
              exit_code: compileResult.exitCode
            },
            reasoning: reproductionResult.reasoning
          };
        } finally {
          // Clean up temp directory
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
        break;
        
      default:
        throw new ReproCheckError(`Unknown category: ${category.category}`);
    }

    // Write JSON to file named [issuenumber].json
    const outputFilename = `${issue.number}.json`;
    fs.writeFileSync(outputFilename, JSON.stringify(result, null, 2), 'utf8');
    console.log(`Analysis complete. Results written to ${outputFilename}`);
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
    // Check if file exists
    if (!fs.existsSync(jsonFilePath)) {
      throw new ReproCheckError(`File not found: ${jsonFilePath}`);
    }
    
    // Read and parse the JSON file
    const jsonContent = fs.readFileSync(jsonFilePath, 'utf8');
    let jsonData;
    try {
      jsonData = JSON.parse(jsonContent);
    } catch (error) {
      throw new ReproCheckError(`Invalid JSON in file ${jsonFilePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = AnalyzeResultSchema.parse(jsonData);
    
    let markdownComment: string;
    
    if ('bug_is_present' in result) {
      // Testable issue
      const compilerDetails = `
**Command:** \`${result.command_line}\`
**TypeScript Version:** ${result.tsc_version}
**Exit Code:** ${result.compiler_output.exit_code}

<details>
<summary>Compiler Output</summary>

**Stdout:**
\`\`\`
${result.compiler_output.stdout || '(empty)'}
\`\`\`

**Stderr:**
\`\`\`
${result.compiler_output.stderr || '(empty)'}
\`\`\`
</details>`;

      if (result.bug_is_present === 'yes') {
        markdownComment = `## Reproduction Confirmed ✅

I was able to reproduce this issue using the following test case:

${result.files.map(file => 
  `**${file.filename}:**
\`\`\`${file.filename.endsWith('.json') ? 'json' : 'typescript'}
${file.content}
\`\`\``
).join('\n\n')}

${compilerDetails}

**What you observed in the bug report:** ${result.user_reported_behavior}
**What you expected:** ${result.expected_behavior}
**What I observed when running tsc:** ${result.current_observed_behavior}

My reasoning:
> ${result.reasoning}

This issue is still present and should remain open.`;
      } else if (result.bug_is_present === 'no') {
        markdownComment = `## Unable to Reproduce ❌

I attempted to reproduce this issue but could not confirm it still exists.

Test case used:
${result.files.map(file => 
  `**${file.filename}:**
\`\`\`${file.filename.endsWith('.json') ? 'json' : 'typescript'}
${file.content}
\`\`\``
).join('\n\n')}

${compilerDetails}

**What you observed in the bug report:** ${result.user_reported_behavior}
**What you expected:** ${result.expected_behavior}
**What I observed when running tsc:** ${result.current_observed_behavior}

My reasoning:
> ${result.reasoning}
`;
      } else if (result.bug_is_present === "can't tell") {
        markdownComment = `## Unclear Result ⚠️

I attempted to analyze this issue but could not make a clear determination about whether it still exists.

Test case used:
${result.files.map(file => 
  `**${file.filename}:**
\`\`\`${file.filename.endsWith('.json') ? 'json' : 'typescript'}
${file.content}
\`\`\``
).join('\n\n')}

${compilerDetails}

**What you observed in the bug report:** ${result.user_reported_behavior}
**What you expected:** ${result.expected_behavior}
**What I observed when running tsc:** ${result.current_observed_behavior}

My reasoning:
> ${result.reasoning}

This issue requires manual review to determine its current status.`;
      } else {
        // This should never happen due to the union type, but adding for safety
        markdownComment = `## Unknown Status ❓

An unexpected bug status was encountered: ${result.bug_is_present}

This requires manual review.`;
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