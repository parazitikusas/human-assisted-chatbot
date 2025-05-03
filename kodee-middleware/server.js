const express = require('express');
const axios = require('axios');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config(); 
const app = express();
const PORT = process.env.PORT || 5001; //middleware
const KODEE_BACKEND_URL = process.env.KODEE_BACKEND_URL || 'http://localhost:8000'; //KODEE BACKEND

// --- Middleware ---
app.use(cors()); // Enable CORS for frontend/CS UI access
app.use(express.json()); // Parse JSON request bodies

let openai;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });
    console.log("OpenAI client initialized.");
} else {
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.warn("!!! WARNING: OPENAI_API_KEY environment variable not set. !!!");
    console.warn("!!! Regenerate functionality will be disabled.           !!!");
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
}

let currentConversationId = null;
let pendingBotResponse = null; 
let isWaitingForCS = false;   
let resolveFrontendRequest = null; 
let rejectFrontendRequest = null;
let csReviewTimeout = null; 
let isHandoffActive = false;
let editedMessagesLogForCurrentChat = []; 

const CS_TIMEOUT_MS = 120000; // 2 minutes timeout for CS review

const forwardRequest = async (req, res, targetPath) => {
    const url = `${KODEE_BACKEND_URL}${targetPath || req.originalUrl}`;
    console.log(`Forwarding ${req.method} request to: ${url}`);

    const headersToForward = { ...req.headers };
    delete headersToForward.host;
    delete headersToForward['content-length']; 

    try {
        const response = await axios({
            method: req.method,
            url: url,
            data: req.body,
            params: req.query,
            headers: headersToForward,
            responseType: 'stream', 
            validateStatus: status => true 
        });

        console.log(`Kodee responded to ${req.method} ${url} with status: ${response.status}`);

        res.status(response.status);
        Object.keys(response.headers).forEach(key => {
             if (key.toLowerCase() !== 'transfer-encoding' || !response.headers['content-length']) {
                res.setHeader(key, response.headers[key]);
             }
        });

        response.data.pipe(res);

        if (req.path === '/api/chat/initialization' || req.path === '/api/chat/restart') {
            return { statusCode: response.status, dataStream: response.data };
        }

    } catch (error) {
        console.error(`Error forwarding request to ${url}:`, error.message);
        if (error.response) {
             console.error('Kodee Error Status:', error.response.status);
             console.error('Kodee Error Data:', error.response.data);
             res.status(error.response.status).send(error.response.data || 'Error from backend service');
        } else if (error.request) {
            console.error('No response received from Kodee');
            res.status(504).send('Gateway Timeout - No response from backend service');
        } else {
            res.status(500).send('Internal Server Error in Middleware');
        }
        return null; 
    }
};


const forwardAndCapture = async (req, res, targetPath) => {
    const url = `${KODEE_BACKEND_URL}${targetPath || req.originalUrl}`;
    console.log(`Forwarding & Capturing ${req.method} request to: ${url}`);

    const headersToForward = { ...req.headers };
    delete headersToForward.host;
    delete headersToForward['content-length'];

    try {
        const response = await axios({
            method: req.method,
            url: url,
            data: req.body,
            params: req.query,
            headers: headersToForward,
            validateStatus: status => true 
        });

        console.log(`Kodee responded to ${req.method} ${url} with status: ${response.status}`);

        res.status(response.status);
         Object.keys(response.headers).forEach(key => {
             if (key.toLowerCase() !== 'transfer-encoding' || !response.headers['content-length']) {
                 res.setHeader(key, response.headers[key]);
             }
         });

        res.send(response.data);

        return { statusCode: response.status, data: response.data };

    } catch (error) {
        console.error(`Error forwarding request to ${url}:`, error.message);
        if (error.response) {
            res.status(error.response.status).send(error.response.data || 'Error from backend service');
        } else if (error.request) {
            res.status(504).send('Gateway Timeout - No response from backend service');
        } else {
            res.status(500).send('Internal Server Error in Middleware');
        }
        return null; 
    }
};


app.post('/api/chat/initialization', async (req, res) => {
    const result = await forwardAndCapture(req, res, '/api/chat/initialization');
    if (result && result.statusCode >= 200 && result.statusCode < 300 && result.data?.conversation_id) {
        currentConversationId = result.data.conversation_id;
        isHandoffActive = false;
        editedMessagesLogForCurrentChat = []; //Clear log for new chat
        console.log(`Middleware: Initialized and tracking conversation_id: ${currentConversationId}`);
        pendingBotResponse = null;
        isWaitingForCS = false;
        if (resolveFrontendRequest) {
            console.warn("Middleware: Cleaning up lingering promise resolver on init.");
            resolveFrontendRequest = null;
            rejectFrontendRequest = null;
        }
        clearTimeout(csReviewTimeout);
    } else if (result) {
        console.warn("Middleware: Initialization request forwarded, but failed or no conversation_id found in response.");
    }
});

app.post('/api/chat/restart', async (req, res) => {
    console.log("Middleware: Restarting chat, clearing state.");
    currentConversationId = null;
    isHandoffActive = false;
    editedMessagesLogForCurrentChat = []; 
    pendingBotResponse = null;
    if (isWaitingForCS && rejectFrontendRequest) {
        console.log("Middleware: Aborting pending CS review due to restart.");
        rejectFrontendRequest(new Error("Chat restarted while waiting for review")); 
    }
    isWaitingForCS = false;
    resolveFrontendRequest = null;
    rejectFrontendRequest = null;
    clearTimeout(csReviewTimeout);


    const result = await forwardAndCapture(req, res, '/api/chat/restart');
    if (result && result.statusCode >= 200 && result.statusCode < 300 && result.data?.conversation_id) {
        currentConversationId = result.data.conversation_id;
        console.log(`Middleware: Restarted. Tracking new conversation_id: ${currentConversationId}. Handoff INACTIVE.`);
    } else if (result) {
        console.warn("Middleware: Restart request forwarded, but failed or no conversation_id found in response.");
    }
});

app.get('/api/history/events', (req, res) => {
    forwardRequest(req, res);
});

app.get('/api/history/messages', async (req, res) => {
    const convId = req.query.conversation_id;

    if (!convId) {
        return res.status(400).json({ error: "Missing conversation_id query parameter" });
    }
    console.log(`Middleware: Fetching combined history for ${convId}`);

    try {
        const kodeeHistoryUrl = `${KODEE_BACKEND_URL}/api/history/messages?conversation_id=${convId}`;
        let originalHistory = [];
        try {
            const kodeeResponse = await axios.get(kodeeHistoryUrl, {
                validateStatus: status => (status >= 200 && status < 300) || status === 404 // Accept 404 Not Found
            });

            if (kodeeResponse.status === 200 && kodeeResponse.data?.status === 'success' && Array.isArray(kodeeResponse.data.data)) {
                originalHistory = kodeeResponse.data.data;
                console.log(`Middleware: Fetched ${originalHistory.length} original messages from Kodee.`);
            } else if (kodeeResponse.status === 404) {
                console.log(`Middleware: No original history found (404) for ${convId} from Kodee.`);
            } else {
                console.warn(`Middleware: Unexpected history response format from Kodee for ${convId}. Status: ${kodeeResponse.status}`, kodeeResponse.data);
            }
        } catch (kodeeError) {
             console.error(`Middleware: Error fetching history from Kodee for ${convId}: ${kodeeError.message}`);
             if (kodeeError.response) {
                 console.error('Kodee Error Status:', kodeeError.response.status);
                 console.error('Kodee Error Data:', kodeeError.response.data);
             }
        }


        let loggedEdits = [];
        if (convId === currentConversationId) {
            loggedEdits = editedMessagesLogForCurrentChat;
             console.log(`Middleware: Found ${loggedEdits.length} logged edited messages for this conversation.`);
        } else {
            console.log(`Middleware: History requested for ${convId}, but middleware is tracking ${currentConversationId}. Not merging edits.`);
        }

        let combinedHistory = [...originalHistory, ...loggedEdits]; // Combine first

        combinedHistory.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
         console.log(`Middleware: Combined history has ${combinedHistory.length} messages after merge and sort.`);


        res.status(200).json({
            status: "success",
            data: combinedHistory
        });

    } catch (error) {
        console.error(`Middleware: Error processing combined history for ${convId}:`, error.message);
        res.status(500).json({ status:"error", error: 'Internal Server Error in Middleware while processing history' });
    }
});

app.post('/api/chat/respond', async (req, res) => {
    const requestConvId = req.body?.conversation_id || currentConversationId;
    console.log(`Middleware: Received POST /api/chat/respond for conversation: ${requestConvId}`);

    if (isWaitingForCS) {
        console.warn("Middleware: Received /respond request while another is waiting for CS. Rejecting.");
        return res.status(429).json({ error: "Too many requests", message: "Middleware is currently handling another response review." });
    }

    if (!requestConvId) {
        console.error("Middleware: Cannot process /respond without a conversation_id.");
        return res.status(400).json({ error: "Bad Request", message: "Missing conversation_id." });
    }
     if (requestConvId !== currentConversationId) {
        console.log(`Middleware: Switching tracked conversation_id to ${requestConvId} based on /respond request.`);
        currentConversationId = requestConvId;
    
        isHandoffActive = false;
        console.log(`Middleware: Handoff reset to INACTIVE due to conversation ID switch.`);
    }


    let responseSent = false; 
    let wasWaitingForCS = false; 
    let localResolve, localReject; 
    const waitForCS = new Promise((resolve, reject) => {
        localResolve = resolve;
        localReject = reject;
    });

    try {
        const kodeeUrl = `${KODEE_BACKEND_URL}/api/chat/respond`;
        console.log(`Middleware: Forwarding user message to Kodee: ${kodeeUrl}`);

        const payloadForKodee = {
            user_id: req.body.user_id,
            role: req.body.role,
            content: req.body.content,
            chatbot_label: req.body.chatbot_label || "chatbot" 
        };
        console.log("Middleware: Constructed payload for Kodee /respond:", JSON.stringify(payloadForKodee, null, 2));

        const kodeeResponse = await axios.post(kodeeUrl, payloadForKodee, {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });

        const botResponseData = kodeeResponse.data;
        console.log(`Middleware: Received response from Kodee (status: ${kodeeResponse.status}).`);

        const shouldHandoffNow = botResponseData?.handoff?.should_handoff === true;

        // Activate handoff permanently for this conversation if triggered
        if (shouldHandoffNow && !isHandoffActive) {
            console.log(`Middleware: Handoff ACTIVATED for conversation ${currentConversationId}. Future messages will require CS review.`);
            isHandoffActive = true;
        }

        if (isHandoffActive) {
            // === PATH 1: Human Review Required ===
            console.log("Middleware: Handoff is active. Proceeding with CS review flow.");
            wasWaitingForCS = true; 

            pendingBotResponse = botResponseData;
            if (pendingBotResponse.conversation_id && pendingBotResponse.conversation_id !== currentConversationId) {
                console.log(`Middleware: conversation_id from Kodee response (${pendingBotResponse.conversation_id}) differs from current (${currentConversationId}). Updating.`);
                currentConversationId = pendingBotResponse.conversation_id;
            }

            isWaitingForCS = true;
            resolveFrontendRequest = localResolve;
            rejectFrontendRequest = localReject;

            clearTimeout(csReviewTimeout); 
            csReviewTimeout = setTimeout(() => {
                if (!responseSent && isWaitingForCS) { // Double check we are still waiting
                    console.log(`Middleware: Timeout waiting ${CS_TIMEOUT_MS}ms for CS specialist review.`);
                    isWaitingForCS = false;
                    pendingBotResponse = null;
                    resolveFrontendRequest = null;
                    rejectFrontendRequest = null;
                    if (res && !res.headersSent) {
                         res.status(504).json({ error: "Gateway Timeout", message: "Timeout waiting for human assistance" });
                         responseSent = true;
                    }
                }
            }, CS_TIMEOUT_MS);

            console.log("Middleware: Holding frontend request, waiting for CS approval via /api/cs/submit_response...");
            const finalResponse = await waitForCS; // Waits here until resolveFrontendRequest or rejectFrontendRequest is called

            if (!responseSent) { 
                console.log("Middleware: CS submitted. Sending final response to frontend.");
                clearTimeout(csReviewTimeout); 
                res.status(200).json(finalResponse); 
                responseSent = true;
            }

        } else {
            // === PATH 2: Auto-Approval ===
            console.log("Middleware: Handoff is NOT active. Auto-approving and sending response directly.");
            res.status(kodeeResponse.status).json(botResponseData);
            responseSent = true;
        }

    } catch (error) {
        if (!responseSent) { 
            console.error("Middleware: Error during /respond flow:", error.message);
            clearTimeout(csReviewTimeout); 

             if (wasWaitingForCS && rejectFrontendRequest) {
                 console.log("Middleware: Rejecting CS wait promise due to error.");
                 rejectFrontendRequest(error); 
             }

            let status = 500;
            let message = "Internal Server Error in Middleware during respond flow";
            if (error.response) { 
                console.error("Kodee Error Details:", error.response.data);
                status = error.response.status || 502;
                message = error.response.data?.detail?.[0]?.msg || error.response.data?.error || `Error from bot backend (Status: ${status})`;
            } else if (error.message.includes("Chat restarted")) { 
                 status = 409; 
                 message = "Chat was restarted during review";
            }
             if (res && !res.headersSent) {
                 res.status(status).json({ error: message });
             }
            responseSent = true;
        } else {
             console.error("Middleware: Error occurred but response already sent:", error.message); 
        }
    } finally {
        if (wasWaitingForCS) {
            console.log("Middleware: Cleaning up /respond CS waiting state.");
            isWaitingForCS = false; 
            pendingBotResponse = null; 
            resolveFrontendRequest = null; 
            rejectFrontendRequest = null;
            clearTimeout(csReviewTimeout); 
        } else {
            console.log("Middleware: Cleaning up /respond state (auto-approval path).");
        }
    }
});


app.get('/api/cs/pending_review', (req, res) => {
    if (isWaitingForCS && pendingBotResponse) {
        console.log("Middleware: CS UI polled - Pending review found.");
        res.status(200).json({
            hasPending: true,
            currentConversationId: currentConversationId,
            bot_response: pendingBotResponse
        });
    } else {
        res.status(200).json({
             hasPending: false,
             currentConversationId: currentConversationId 
        });
    }
});

app.post('/api/cs/submit_response', (req, res) => {
    console.log("Middleware: Received POST /api/cs/submit_response");
    console.log("DEBUG: CS Submit Request Body:", JSON.stringify(req.body, null, 2));

    if (!isWaitingForCS || !resolveFrontendRequest) {
        console.warn("Middleware: Received CS submission, but middleware wasn't waiting or promise resolver is missing.");
        return res.status(400).json({ error: "Bad Request", message: "No pending response review found or it already timed out/restarted." });
    }

    try {
        const editedResponse = req.body.edited_response; 

        if (!editedResponse) {
            console.warn("Middleware: CS submission missing 'edited_response' field in request body.");
            return res.status(400).json({ error: "Bad Request", message: "Request body must contain 'edited_response' object." });
        }

        if (!editedResponse.conversation_id || !editedResponse.message?.role || typeof editedResponse.message?.content !== 'string') {
            console.warn("Middleware: CS submitted response has invalid structure or missing fields.");
            return res.status(400).json({ error: "Bad Request", message: "The 'edited_response' object has an invalid structure. Expected fields like 'conversation_id', 'message.role', and 'message.content' (string)." });
        }
        console.log("DEBUG: Validated editedResponse payload:", JSON.stringify(editedResponse, null, 2));


        let adjustedTimestamp;
        try {
            const submissionTime = new Date(); 
            console.log(`DEBUG: Current submission time (UTC): ${submissionTime.toISOString()}`);
            // Subtract 3 hours (3 * 60 * 60 * 1000 milliseconds)
            submissionTime.setTime(submissionTime.getTime() - (3 * 60 * 60 * 1000));
            adjustedTimestamp = submissionTime.toISOString(); 
            console.log(`DEBUG: Adjusted timestamp (-3 hours): ${adjustedTimestamp}`);
        } catch(dateError) {
            console.error("Middleware: Error adjusting timestamp:", dateError);
            adjustedTimestamp = new Date().toISOString(); 
            console.warn("Middleware: Using current time as fallback timestamp due to error.");
        }


        const historyLogEntry = {
            id: `edited-${Date.now()}`, 
            conversation_id: editedResponse.conversation_id || currentConversationId,
            author_type: 'cs_specialist',
            message: editedResponse.message.content,
            chatbot_label: editedResponse.message.chatbot_label || pendingBotResponse?.message?.chatbot_label || 'edited',
            created_at: adjustedTimestamp, 
            isEdited: true
        };
        console.log("DEBUG: Constructed history log entry:", JSON.stringify(historyLogEntry, null, 2));

        editedMessagesLogForCurrentChat.push(historyLogEntry);
        console.log(`DEBUG: Pushed to editedMessagesLogForCurrentChat. New length: ${editedMessagesLogForCurrentChat.length}`);


        console.log("Middleware: CS submitted valid response. Resolving promise for frontend request.");
        resolveFrontendRequest(editedResponse); 


        res.status(200).json({ status: "success", message: "Response submitted and sent to user." });

    } catch (error) {
        console.error("Middleware: Unexpected error occurred during CS submission processing/logging:", error);
        if (res && !res.headersSent) {
             res.status(500).json({ status: "error", message: "Failed to process submitted response due to an internal error." });
        }
    }
});



app.post('/api/cs/regenerate_response', async (req, res) => {
    console.log("Middleware: Received POST /api/cs/regenerate_response");

    // 1. Pre-checks
    if (!openai) {
        console.error("Middleware: OpenAI client not initialized (API key missing). Cannot regenerate.");
        return res.status(503).json({ error: "Service Unavailable", message: "Regeneration feature not configured." });
    }
    if (!isWaitingForCS || !pendingBotResponse) {
        console.warn("Middleware: Received regenerate request, but no response is pending review.");
        return res.status(400).json({ error: "Bad Request", message: "No response is currently pending review." });
    }

    const feedback = req.body.feedback;
    if (!feedback || typeof feedback !== 'string' || feedback.trim().length === 0) {
        console.warn("Middleware: Regenerate request missing valid 'feedback' text.");
        return res.status(400).json({ error: "Bad Request", message: "Feedback text is required for regeneration." });
    }

    const originalBotResponseContent = pendingBotResponse.message?.content;
    if (!originalBotResponseContent) {
         console.error("Middleware: Cannot regenerate - pendingBotResponse has no message content.");
         return res.status(500).json({ error: "Internal Server Error", message: "Could not find original message content to regenerate." });
    }

    console.log(`Middleware: Requesting regeneration for conv ${currentConversationId} with feedback: "${feedback}"`);

    // 2. Fetch Chat History
    let recentHistory = [];
    try {
        console.log(`Middleware: Fetching history for regeneration prompt (conv: ${currentConversationId})`);
        const historyUrl = `${KODEE_BACKEND_URL}/api/history/messages?conversation_id=${currentConversationId}`;
        const historyResponse = await axios.get(historyUrl);
        if (historyResponse.data?.status === 'success' && Array.isArray(historyResponse.data.data)) {
            recentHistory = historyResponse.data.data
                .slice(-10) 
                .map(msg => ({
                    role: msg.author_type === 'user' ? 'user' : 'assistant',
                    content: typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message) // Handle potential object messages
                }));
            console.log(`Middleware: Fetched ${recentHistory.length} messages for history context.`);
        } else {
            console.warn("Middleware: Could not fetch valid history from Kodee for regeneration prompt.");
        }
    } catch (histError) {
        console.error("Middleware: Error fetching history for regeneration:", histError.message);

    }

    const systemPrompt = `You are a helpful customer service assistant supervisor. You revise initial AI responses based on agent feedback. Given the chat history, the original AI response, and specific feedback, rewrite the original response to incorporate the feedback effectively. Maintain the core intent unless the feedback directs otherwise. Output ONLY the revised response text, ready to be sent to the customer.`;

    const userPromptContent = `Chat History (Last ${recentHistory.length} messages):
${recentHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

Original AI Response to Revise:
assistant: ${originalBotResponseContent}

Agent Feedback:
${feedback}

Instructions: Rewrite the "Original AI Response to Revise" incorporating the "Agent Feedback". Consider the "Chat History" for context. Output ONLY the revised response text.`;

    try {
        console.log("Middleware: Calling OpenAI Chat Completions API...");
        const completion = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPromptContent }
            ],
            temperature: 0.7,
            max_tokens: 250, 
        });

        const regeneratedContent = completion.choices[0]?.message?.content?.trim();

        if (!regeneratedContent) {
             console.error("Middleware: OpenAI response was empty or malformed.", completion);
             throw new Error("Failed to get valid content from AI regeneration.");
        }
        console.log(`Middleware: Received regenerated content from OpenAI: "${regeneratedContent}"`);

        
        const newPendingResponse = {
             ...pendingBotResponse, 
             message: {
                 ...pendingBotResponse.message, 
                 content: regeneratedContent, 
             },
             regenerated_with_feedback: feedback, 
             original_content_before_regen: originalBotResponseContent 
        };

        pendingBotResponse = newPendingResponse; 
        console.log("Middleware: Updated pendingBotResponse with regenerated content.");

        res.status(200).json({ status: "success", message: "Response regenerated successfully." });

    } catch (openaiError) {
        console.error("Middleware: Error during OpenAI call or processing:", openaiError);
        let errorMessage = "Failed to regenerate response due to AI service error.";
        if (openaiError.response) { 
          console.error("OpenAI Error Details:", openaiError.response.data);
          errorMessage = openaiError.response.data?.error?.message || errorMessage;
        } else if (openaiError instanceof Error) {
            errorMessage = openaiError.message;
        }
        res.status(500).json({ error: "AI Regeneration Failed", message: errorMessage });
    }
});


// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Kodee Middleware server running on port ${PORT}`);
    console.log(`Proxying requests to: ${KODEE_BACKEND_URL}`);
});