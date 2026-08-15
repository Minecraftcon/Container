import { load } from "https://deno.land/std@0.210.0/dotenv/mod.ts";

const CHANNEL_ID = Deno.env.get("CHANNEL_ID") || "";
const MESSAGE_ID = Deno.env.get("MESSAGE_ID") || "";
const CHAT_ID = Deno.env.get("CHAT_ID") || "";
const PROMPT = Deno.env.get("PROMPT") || "";
const MISTRAL_API_KEY = Deno.env.get("MISTRAL_API_KEY") || "";
const SUPABASE_WEBHOOK_URL = Deno.env.get("SUPABASE_WEBHOOK_URL") || "";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function sendWebhook(type: string, data: any = {}) {
  try {
    await fetch(SUPABASE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        type,
        ...data,
      }),
    });
  } catch (e) {
    console.error("Failed to send webhook:", e);
  }
}

const tools = [
  {
    type: "function",
    function: {
      name: "bash_exec",
      description: "Execute a bash command in the sandbox",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file in the workspace",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path like /home/runner/stable/test.txt" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  }
];

async function callMistral(messages: any[]) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: "mistral-small-2501",
      messages,
      tools,
      stream: true,
      reasoning_effort: "high",
      temperature: 0.5,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    await sendWebhook("error", { error: `Mistral API Error: ${errorText}` });
    return null;
  }

  const reader = res.body?.getReader();
  const decoder = new TextDecoder("utf-8");

  let fullContent = "";
  let fullReasoning = "";
  let toolCalls: any = null;

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter(line => line.trim() !== "");

      for (const line of lines) {
        if (line === "data: [DONE]") break;
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.substring(6));
            const delta = data.choices?.[0]?.delta;
            
            if (delta) {
              // Parse tool_calls
              if (delta.tool_calls) {
                if (!toolCalls) toolCalls = delta.tool_calls;
                else {
                  // Merge tool call chunks
                  for (const tc of delta.tool_calls) {
                    const existing = toolCalls.find((t: any) => t.index === tc.index);
                    if (existing) {
                      existing.function.arguments += (tc.function?.arguments || "");
                    } else {
                      toolCalls.push(tc);
                    }
                  }
                }
              }

              if (delta.content) {
                if (typeof delta.content === "string") {
                  fullContent += delta.content;
                  await sendWebhook("chunk", { text: delta.content });
                } else if (Array.isArray(delta.content)) {
                  for (const block of delta.content) {
                    if (block.type === "thinking" && Array.isArray(block.thinking)) {
                      for (const t of block.thinking) {
                        if (t.type === "text" && t.text) {
                          fullReasoning += t.text;
                          await sendWebhook("reasoning_chunk", { text: t.text });
                        }
                      }
                    } else if (block.type === "text" && block.text) {
                      fullContent += block.text;
                      await sendWebhook("chunk", { text: block.text });
                    }
                  }
                }
              }
            }
          } catch (e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    }
  }

  return { fullContent, fullReasoning, toolCalls };
}

async function executeAgentLoop(prompt: string) {
  await sendWebhook("status", { status: "Thinking..." });

  const messages: any[] = [
    {
      role: "system",
      content: `You are an expert developer AI in 'Work Mode' running inside an isolated Linux sandbox.
Workspace is at /home/runner/stable. Always use the provided tools to execute the user's request.`,
    },
    { role: "user", content: prompt },
  ];

  let currentReasoning = "";
  let currentContent = "";

  while (true) {
    const response = await callMistral(messages);
    if (!response) break;

    const { fullContent, fullReasoning, toolCalls } = response;
    currentReasoning += fullReasoning + "\n";
    currentContent += fullContent + "\n";

    if (!toolCalls || toolCalls.length === 0) {
      // Done
      break;
    }

    // Execute tools
    messages.push({
      role: "assistant",
      content: fullContent || "",
      tool_calls: toolCalls
    });

    for (const tc of toolCalls) {
      if (tc.type === "function") {
        const name = tc.function.name;
        const args = JSON.parse(tc.function.arguments);
        let result = "";

        await sendWebhook("status", { status: `Executing ${name}...` });

        try {
          if (name === "bash_exec") {
            const command = new Deno.Command("bash", { args: ["-c", args.command] });
            const output = await command.output();
            result = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
          } else if (name === "write_file") {
            await Deno.writeTextFile(args.path, args.content);
            result = `File successfully written to ${args.path}`;
          }
        } catch (e: any) {
          result = `Error: ${e.message}`;
        }

        messages.push({
          role: "tool",
          name: name,
          tool_call_id: tc.id,
          content: result || "Success (no output)"
        });
      }
    }
  }

  // Finalize
  await sendWebhook("done", {
    reply: currentContent.trim(),
    content_full: currentContent.trim(),
    reasoning_full: currentReasoning.trim()
  });
}

// 1. Execute the initial prompt
console.log("Starting agent loop for prompt:", PROMPT);
await executeAgentLoop(PROMPT);

// 2. Idle Timer for Auto-Destruction
console.log(`Initial task complete. Entering idle mode for ${IDLE_TIMEOUT_MS / 1000} seconds...`);
// In a fully implemented system, we would subscribe to Supabase Realtime here 
// to listen for NEW messages from the user on this CHAT_ID, resetting the timer.

const idleTimer = setTimeout(() => {
  console.log("Idle timeout reached. Shutting down GitHub Action runner to save minutes.");
  Deno.exit(0);
}, IDLE_TIMEOUT_MS);

// For now, since we haven't implemented the listener yet, we will just let the timer run out.
// If you implement the listener: 
// function resetIdleTimer() { clearTimeout(idleTimer); idleTimer = setTimeout(..., IDLE_TIMEOUT_MS); }
