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
    private systemPrompt: string;
    private greeting: string;
    private model: string;
    private temperature: number;
    private maxTokens: number;
    private reminderText: string;
    private supabase: any;

    constructor() {
        this.openaiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        const supabaseUrl = process.env.SUPABASE_URL || "";
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
        this.supabase = createClient(supabaseUrl, supabaseKey);

        // Default values
        this.systemPrompt = `## Identity\nYou are a helpful AI assistant for Clinibot...`;
        this.greeting = "Hola, ¿en qué puedo ayudarte hoy?";
        this.model = "gpt-4o-mini";
        this.temperature = 0.8;
        this.maxTokens = 400;
        this.reminderText = "(The user has been silent for a while. Send a brief, friendly follow-up.)";
    }

    /**
     * Fetch configuration from Supabase.
     */
    async initialize(): Promise<void> {
        try {
            const { data, error } = await this.supabase
                .from("config")
                .select("*")
                .eq("id", "current")
                .single();

            if (data && !error) {
                this.systemPrompt = data.system_prompt || this.systemPrompt;
                this.greeting = data.greeting || this.greeting;
                this.model = data.model || this.model;
                this.temperature = data.temperature !== undefined ? data.temperature : this.temperature;
                this.maxTokens = data.max_tokens || this.maxTokens;
                this.reminderText = data.reminder_text || this.reminderText;
                console.log("Config loaded from Supabase");
            }
        } catch (err) {
            console.log("Using default config (Supabase not ready)");
        }
    }

    /**
     * Called when WebSocket connection is established.
     * Sends the first message to greet the user.
     */
    BeginMessage(ws: WebSocket): void {
        const event: RetellResponseEvent = {
            response_type: "response",
            response_id: 0,
            content: this.greeting,
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
        if (request.interaction_type === "update_only") return;

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: this.systemPrompt },
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
                content: this.reminderText,
            });
        }

        try {
            const stream = await this.openaiClient.chat.completions.create({
                model: this.model as any,
                messages: messages,
                temperature: this.temperature,
                max_tokens: this.maxTokens,
                stream: true,
            });

            for await (const chunk of stream) {
                if (ws.readyState !== WebSocket.OPEN) return;

                const delta = chunk.choices[0]?.delta?.content;
                if (delta) {
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

            if (ws.readyState === WebSocket.OPEN) {
                const finalEvent: RetellResponseEvent = {
                    response_type: "response",
                    response_id: request.response_id!,
                    content: "",
                    content_complete: true,
                    end_call: false,
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
