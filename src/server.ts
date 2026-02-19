import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import { RawData, WebSocket } from "ws";
import expressWs from "express-ws";
import { LlmOpenAiClient } from "./llm-openai-client";
import {
    RetellRequest,
    RetellConfigEvent,
    RetellPingPongEvent,
} from "./types";

// ============================================================
// Server Setup
// ============================================================

const app = express();
const wsInstance = expressWs(app);
const port = parseInt(process.env.PORT || "8080", 10);

// ============================================================
// HTTP Routes
// ============================================================

app.get("/", (_req: Request, res: Response) => {
    res.json({
        status: "ok",
        service: "Retell Custom LLM WebSocket Server",
        timestamp: new Date().toISOString(),
    });
});

// ============================================================
// WebSocket Route — Retell LLM Integration
// ============================================================

wsInstance.app.ws(
    "/llm-websocket/:call_id",
    async (ws: WebSocket, req: Request) => {
        const callId = req.params.call_id;
        console.log(`[${callId}] WebSocket connected`);

        // Create a new LLM client for this call
        const llmClient = new LlmOpenAiClient();

        // --- Send config event ---
        const configEvent: RetellConfigEvent = {
            response_type: "config",
            config: {
                auto_reconnect: true,
                call_details: false,
            },
        };
        ws.send(JSON.stringify(configEvent));

        // --- Send begin message (agent speaks first) ---
        llmClient.BeginMessage(ws);

        // --- Handle errors ---
        ws.on("error", (err: Error) => {
            console.error(`[${callId}] WebSocket error:`, err);
        });

        // --- Handle close ---
        ws.on("close", (code: number, reason: Buffer) => {
            console.log(
                `[${callId}] WebSocket closed — code: ${code}, reason: ${reason.toString()}`
            );
        });

        // --- Handle incoming messages from Retell ---
        ws.on("message", async (data: RawData, isBinary: boolean) => {
            if (isBinary) {
                console.error(`[${callId}] Received binary message, expected text.`);
                ws.close(1002, "Expected text message, got binary.");
                return;
            }

            try {
                const request: RetellRequest = JSON.parse(data.toString());

                // Handle ping_pong — echo back timestamp
                if (request.interaction_type === "ping_pong") {
                    const pong: RetellPingPongEvent = {
                        response_type: "ping_pong",
                        timestamp: request.timestamp!,
                    };
                    ws.send(JSON.stringify(pong));
                    return;
                }

                // Handle call_details — log and ignore
                if (request.interaction_type === "call_details") {
                    console.log(`[${callId}] Call details received:`, request.call);
                    return;
                }

                // Handle update_only, response_required, reminder_required
                llmClient.DraftResponse(request, ws);
            } catch (err) {
                console.error(`[${callId}] Error parsing message:`, err);
                ws.close(1002, "Cannot parse incoming message.");
            }
        });
    }
);

// ============================================================
// Start Server
// ============================================================

app.listen(port, () => {
    console.log(`🚀 Retell Custom LLM server listening on port ${port}`);
    console.log(`   Health check: http://localhost:${port}/`);
    console.log(
        `   WebSocket:    ws://localhost:${port}/llm-websocket/{call_id}`
    );
});
