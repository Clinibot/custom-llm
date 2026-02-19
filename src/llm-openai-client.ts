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
    private knowledgeBase: string = "";
    private webhookUrl: string = "";
    private hangupPhrases: string[] = [];
    private extractionFields: string = "";
    private language: string = "Spanish";
    private supabase: any;

    constructor() {
        this.openaiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        const supabaseUrl = process.env.SUPABASE_URL || "";
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
        this.supabase = createClient(supabaseUrl, supabaseKey);

        if (!process.env.OPENAI_API_KEY) {
            console.error("[LlmOpenAiClient] CRITICAL: OPENAI_API_KEY is missing from environment.");
        }

        // Default values
        this.systemPrompt = "";
        this.greeting = "";
        this.model = "gpt-4o-mini";
        this.temperature = 0.8;
        this.maxTokens = 400;
        this.reminderText = "";
        this.knowledgeBase = "";
        this.webhookUrl = "";
        this.hangupPhrases = [];
        this.extractionFields = "";
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
                this.temperature = data.temperature ?? 0.8;
                this.maxTokens = data.max_tokens || 400;
                this.reminderText = data.reminder_text || "";
                this.knowledgeBase = data.knowledge_base || "";
                this.webhookUrl = data.webhook_url || "";
                this.hangupPhrases = data.hangup_phrases ? data.hangup_phrases.split(",").map((s: string) => s.trim().toLowerCase()) : [];
                this.extractionFields = data.extraction_fields || "";
                this.language = data.language || "es";
                console.log(`Config loaded for agent: ${agentId}`);
            }
        } catch (err) {
            console.log("Error loading config:", err);
        }
    }

    /**
     * Simple RAG: Search Supabase for relevant content.
     * Expects a 'documents' table with 'content' and 'embedding' columns.
     */
    async getRelevantContext(query: string): Promise<string> {
        if (!this.knowledgeBase) return "";
        try {
            // 1. Generate embedding for the query
            const embeddingResponse = await this.openaiClient.embeddings.create({
                model: "text-embedding-3-small",
                input: query,
            });
            const embedding = embeddingResponse.data[0].embedding;

            // 2. Search Supabase using vector similarity
            // Requires match_documents stored procedure
            const { data, error } = await this.supabase.rpc("match_documents", {
                query_embedding: embedding,
                match_threshold: 0.5,
                match_count: 3,
                filter_kb_id: this.knowledgeBase
            });

            if (error || !data) return "";
            return data.map((d: any) => d.content).join("\n\n");
        } catch (err) {
            console.error("RAG Error:", err);
            return "";
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
        console.log(`[DraftResponse] Type: ${request.interaction_type}, Response ID: ${request.response_id}, Turntaking: ${request.turntaking}`);

        if (request.interaction_type === "update_only") {
            if (request.turntaking === "agent_turn") {
                console.log(`[${request.response_id}] [Protocol] Agent turn detected in update_only. Continuing.`);
            } else {
                return;
            }
        }

        console.log(`[${request.response_id}] [LLM] Beginning response generation...`);

        // 1. Context Retrieval (RAG)
        let context = "";
        const lastUserMessage = request.transcript?.filter(u => u.role === "user").pop();
        if (lastUserMessage && this.knowledgeBase) {
            context = await this.getRelevantContext(lastUserMessage.content);
        }

        // 2. Build System Prompt with Metadata
        let fullSystemPrompt = this.systemPrompt;
        if (context) {
            fullSystemPrompt += `\n\n## Relevant Context (Use this to answer questions):\n${context}`;
        }
        if (this.extractionFields) {
            fullSystemPrompt += `\n\n## Mission: You MUST extract these fields during the conversation: ${this.extractionFields}`;
        }
        fullSystemPrompt += `\n\n## Language Instruction: Always communicate in ${this.language}.`;

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: fullSystemPrompt },
        ];

        if (request.transcript) {
            for (const utterance of request.transcript) {
                messages.push({
                    role: utterance.role === "agent" ? "assistant" : "user",
                    content: utterance.content,
                });
            }
        }

        if (request.interaction_type === "reminder_required") {
            messages.push({
                role: "user",
                content: this.reminderText || "(The user has been silent. Send a friendly follow-up.)",
            });
        }

        console.log(`[${request.response_id}] [OpenAI] Calling with ${messages.length} messages. Model: ${this.model}`);
        try {
            const stream = await this.openaiClient.chat.completions.create({
                model: this.model as any,
                messages: messages,
                temperature: this.temperature,
                max_tokens: this.maxTokens,
                stream: true,
            });
            console.log(`[${request.response_id}] [OpenAI] Stream opened.`);

            let fullAgentResponse = "";

            for await (const chunk of stream) {
                if (ws.readyState !== WebSocket.OPEN) return;

                const delta = chunk.choices[0]?.delta?.content;
                if (delta) {
                    fullAgentResponse += delta;
                    const event: RetellResponseEvent = {
                        response_type: "response",
                        response_id: request.response_id!,
                        content: delta,
                        content_complete: false,
                        end_call: false,
                    };
                    ws.send(JSON.stringify(event));
                }
            }
            console.log(`[${request.response_id}] [LLM] Stream complete. Total chars: ${fullAgentResponse.length}`);

            // 3. Hangup Logic & Lead Capture
            const shouldHangUp = this.hangupPhrases.some(phrase =>
                fullAgentResponse.toLowerCase().includes(phrase)
            );

            if (ws.readyState === WebSocket.OPEN) {
                const finalEvent: RetellResponseEvent = {
                    response_type: "response",
                    response_id: request.response_id!,
                    content: "",
                    content_complete: true,
                    end_call: shouldHangUp,
                };
                ws.send(JSON.stringify(finalEvent));
            }

        } catch (err) {
            console.error("Error in OpenAI streaming:", err);
            if (ws.readyState === WebSocket.OPEN) {
                const fallback: RetellResponseEvent = {
                    response_type: "response",
                    response_id: request.response_id!,
                    content: "Disculpa, tuve un problema procesando tu solicitud. ¿Podrías repetirlo?",
                    content_complete: true,
                    end_call: false,
                };
                ws.send(JSON.stringify(fallback));
            }
        }
    }

}
