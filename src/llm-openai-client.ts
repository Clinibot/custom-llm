import OpenAI from "openai";
import { WebSocket } from "ws";
import {
    RetellRequest,
    RetellResponseEvent,
    Utterance,
} from "./types";

/**
 * Custom LLM client using OpenAI GPT for Retell AI.
 * Streams responses back to Retell via WebSocket.
 */
export class LlmOpenAiClient {
    private openaiClient: OpenAI;
    private systemPrompt: string;

    constructor() {
        this.openaiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        // Customize this system prompt to define your agent's personality and behavior
        this.systemPrompt = `## Identity
You are a helpful AI assistant for Clinibot. You help users with their questions in a friendly, professional manner.

## Style
- Be concise and clear in your responses
- Use a warm and professional tone
- If you don't know something, say so honestly
- Keep responses conversational and natural for voice interaction
- Avoid using markdown, bullet points, or formatting — this is a voice conversation`;
    }

    /**
     * Called when WebSocket connection is established.
     * Sends the first message to greet the user.
     */
    BeginMessage(ws: WebSocket): void {
        const event: RetellResponseEvent = {
            response_type: "response",
            response_id: 0,
            content: "Hola, ¿en qué puedo ayudarte hoy?",
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
        // Only respond to response_required and reminder_required events
        if (request.interaction_type === "update_only") {
            // Optionally process live transcript updates here
            return;
        }

        // Prepare messages for OpenAI
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: this.systemPrompt },
        ];

        // Add conversation history from transcript
        if (request.transcript) {
            for (const utterance of request.transcript) {
                messages.push({
                    role: utterance.role === "agent" ? "assistant" : "user",
                    content: utterance.content,
                });
            }
        }

        // If it's a reminder (user hasn't spoken), add a hint
        if (request.interaction_type === "reminder_required") {
            messages.push({
                role: "user",
                content: "(The user has been silent for a while. Send a brief, friendly follow-up.)",
            });
        }

        try {
            // Stream response from OpenAI
            const stream = await this.openaiClient.chat.completions.create({
                model: "gpt-4o-mini",
                messages: messages,
                temperature: 0.8,
                max_tokens: 400,
                stream: true,
            });

            for await (const chunk of stream) {
                // Check if WebSocket is still open
                if (ws.readyState !== WebSocket.OPEN) {
                    return;
                }

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

            // Send final event marking content as complete
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

            // Send a fallback response
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
