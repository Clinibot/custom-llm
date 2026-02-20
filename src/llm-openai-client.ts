import OpenAI from "openai";
import { WebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import {
    RetellRequest,
    RetellResponseEvent,
} from "./types";

/**
 * Custom LLM client using OpenAI GPT for Retell AI.
 */
export class LlmOpenAiClient {
    private openaiClient: OpenAI;
    public agentId: string | null = null;
    public greeting: string = "";
    private systemPrompt: string = "";
    private model: string = "gpt-4o-mini";
    private temperature: number = 0.7;
    private maxTokens: number = 512;
    private reminderText: string = "";
    private language: string = "Spanish";
    private supabase: any;

    constructor() {
        // We will initialize the OpenAI client per-agent in initialize()
        this.openaiClient = null as any;

        const supabaseUrl = process.env.SUPABASE_URL || "";
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
        this.supabase = createClient(supabaseUrl, supabaseKey);


        // Default values
        this.systemPrompt = "";
        this.greeting = "";
        this.model = "gpt-4o-mini";
        this.temperature = 0.8;
        this.maxTokens = 400;
        this.reminderText = "";
        this.language = "es";
        this.agentId = "";
    }

    /**
     * Fetch configuration from Supabase for a specific agent.
     */
    async initialize(agentId: string): Promise<void> {
        this.agentId = agentId;
        try {
            const { data, error } = await this.supabase
                .from("agents")
                .select("*")
                .eq("id", agentId)
                .single();

            if (data && !error) {
                this.systemPrompt = data.system_prompt || "";
                this.greeting = data.greeting || "";
                this.model = data.model || "gpt-4o-mini";
                this.temperature = 0; // Enforced for deterministic behavior and task consistency (Lesson 4)
                this.maxTokens = data.max_tokens || 400;
                this.reminderText = data.reminder_text || "";
                this.language = data.language || "es";

                // Multi-user: Strictly use agent-specific OpenAI key
                if (data.openai_api_key) {
                    console.log(`[${agentId}] Initializing OpenAI with agent-specific key.`);
                    this.openaiClient = new OpenAI({
                        apiKey: data.openai_api_key,
                    });
                } else {
                    console.warn(`[${agentId}] WARNING: No OpenAI API key found for this agent.`);
                    this.openaiClient = null as any;
                }

                console.log(`Config loaded for agent: ${agentId}`);
            }
        } catch (err) {
            console.log("Error loading config:", err);
        }
    }


    /**
     * Called when WebSocket connection is established.
     * Sends the first message to greet the user.
     */
    BeginMessage(ws: WebSocket): void {
        const content = this.greeting || "Hola, ¿cómo puedo ayudarte?";
        console.log(`[${this.agentId}] Sending greeting: "${content}"`);
        const event: RetellResponseEvent = {
            response_type: "response",
            response_id: 0,
            content: content,
            content_complete: true,
            end_call: false,
        };
        ws.send(JSON.stringify(event));
    }

    /**
     * Processes incoming requests from Retell and generates streaming responses via OpenAI.
     */
    async DraftResponse(
        request: RetellRequest,
        ws: WebSocket
    ): Promise<void> {
        if (request.interaction_type === "ping_pong") {
            ws.send(JSON.stringify({
                response_type: "ping_pong",
                timestamp: request.timestamp
            }));
            return;
        }

        if (request.interaction_type === "update_only") {
            // Update only is just a transcript update, no response needed
            return;
        }

        if (request.interaction_type !== "response_required" && request.interaction_type !== "reminder_required") {
            console.log(`[DraftResponse] Ignoring interaction_type: ${request.interaction_type}`);
            return;
        }

        if (request.response_id === undefined) {
            console.error("[DraftResponse] Error: Missing response_id for response_required event.");
            return;
        }

        console.log(`[${request.response_id}] [LLM] Processing ${request.interaction_type}...`);

        console.log(`[${request.response_id}] [LLM] Processing ${request.interaction_type}...`);

        // 2. Build System Prompt with Voice Protocol (5 Lessons)
        let fullSystemPrompt = `## Advanced Voice Protocol:\n`;
        fullSystemPrompt += `- BREVITY: Keep responses under 15 words. Use direct sentences.\n`;
        fullSystemPrompt += `- FILLER WORDS: Start responses with "Eh...", "Verá...", or "Mmm..." to mask latency when thinking (Lesson 2).\n`;
        fullSystemPrompt += `- ASR GRACE: If the last message is nonsensical or noisy, use: "Hay estática en la línea", "Le escucho entrecortado" or "No capte eso bien, ¿podría repetir?". NEVER admit a software error.\n`;
        fullSystemPrompt += `- TURNS: Be concise to encourage a fast back-and-forth.\n\n`;

        fullSystemPrompt += `## User System Prompt:\n${this.systemPrompt}`;

        const messages: any[] = [{ role: "system", content: fullSystemPrompt || "Eres un asistente de voz servicial." }];
        if (request.transcript) {
            request.transcript.forEach(u => {
                if (u.content && u.content.trim()) {
                    messages.push({
                        role: u.role === "agent" ? "assistant" : "user",
                        content: u.content
                    });
                }
            });
        }

        // Safety: If no messages, OpenAI will error. Ensure at least one system message.
        if (messages.length === 1 && messages[0].role === "system" && (!messages[0].content)) {
            messages[0].content = "Hola";
        }

        console.log(`[${request.response_id}] [OpenAI] Querying ${this.model}... Payload: ${JSON.stringify(messages).substring(0, 300)}...`);

        try {
            if (!this.openaiClient) {
                throw new Error("No OpenAI API Key configured for this agent. Please add it in the dashboard.");
            }
            const stream = await this.openaiClient.chat.completions.create({
                model: this.model as any,
                messages: messages,
                temperature: this.temperature,
                max_tokens: this.maxTokens,
                stream: true,
            });

            console.log(`[${request.response_id}] [OpenAI] Streaming response...`);
            let fullAgentResponse = "";

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta?.content;
                if (delta) {
                    fullAgentResponse += delta;
                    const event: RetellResponseEvent = {
                        response_type: "response",
                        response_id: request.response_id, // Match the ID
                        content: delta,
                        content_complete: false,
                        end_call: false,
                    };
                    ws.send(JSON.stringify(event));
                }
            }

            // End of stream
            ws.send(JSON.stringify({
                response_type: "response",
                response_id: request.response_id,
                content: "",
                content_complete: true,
                end_call: false,
            }));

            console.log(`[${request.response_id}] [LLM] Success. Length: ${fullAgentResponse.length}`);
        } catch (err: any) {
            console.error(`[${request.response_id}] [OpenAI] CRITICAL ERROR:`, {
                message: err.message,
                code: err.code,
                status: err.status,
                type: err.type,
                data: err.response?.data
            });

            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    response_type: "response",
                    response_id: request.response_id,
                    content: `Lo siento, tengo un problema técnico momentáneo. (Error: ${err.message || 'Unknown'})`,
                    content_complete: true,
                    end_call: false,
                }));
            }
        }
    }
}
