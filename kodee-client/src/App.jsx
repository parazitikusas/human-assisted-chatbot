import React, { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/components/ui/use-toast";
import { AnimatePresence } from "framer-motion";
import { RotateCcw } from "lucide-react";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput } from "@/components/ChatInput";


const API_BASE_URL = "http://localhost:5001/api"; // middleware link

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState(null);
  const [loading, setLoading] = useState(false); // loading now indicates waiting for user input OR CS review
  const messagesEndRef = useRef(null);
  const { toast } = useToast();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    initializeChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const initializeChat = async () => {
    console.log("Initializing chat via middleware...");
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE_URL}/chat/initialization`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: "test",
          metadata: {
            domain_name: "example.com", // Example metadata
          },
        }),
      });

      if (!response.ok) {
         const errorData = await response.text();
         console.error("Init Error Response:", errorData);
         throw new Error(`Failed to initialize chat (Status: ${response.status})`);
      }

      const data = await response.json();
      console.log("Initialization successful, Conversation ID:", data.conversation_id);
      setConversationId(data.conversation_id);
      setMessages(data.history || []);


    } catch (error) {
      console.error("Initialization failed:", error);
      toast({
        title: "Error",
        description: `Initialization failed: ${error.message}. Please try refreshing.`,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };


  const fetchMessages = async (convId) => {
    console.log(`Fetching messages for ${convId} via middleware...`);
    try {
      const response = await fetch(
        `${API_BASE_URL}/history/messages?conversation_id=${convId}`
      );

      if (!response.ok) {
        if (response.status !== 404) {
          const errorData = await response.text();
          console.error("Fetch History Error Response:", errorData);
          throw new Error(`Failed to fetch messages (Status: ${response.status})`);
        }
        console.log("No message history found (404).");
        setMessages([]); 
        return;
      }

      const data = await response.json();
      if (data.status === "success" && Array.isArray(data.data)) {
        console.log("Fetched messages:", data.data);
        setMessages(data.data);
      } else {
        console.warn("Fetched messages response format unexpected:", data);
         if (Array.isArray(data)) {
            setMessages(data);
         } else {
            setMessages([]); 
         }
      }
    } catch (error) {
       console.error("Fetching history failed:", error);
        if (!error.message.includes("Status: 404")) {
            toast({
                title: "Error",
                description: `Failed to fetch message history: ${error.message}.`,
                variant: "destructive",
            });
        }
        setMessages([]); 
    } finally {
    }
  };


  const handleSend = async () => {
    if (!input.trim() || !conversationId) return;

    const userMessage = input.trim();
    const currentConvId = conversationId;
    setInput("");

    const tempUserMessage = {
      id: `user-${Date.now()}`,
      conversation_id: currentConvId,
      author_type: "user",
      message: userMessage,
      created_at: new Date().toISOString(),
      isOptimistic: true 
    };
    setMessages(prev => [...prev, tempUserMessage]);

    console.log(`Sending message to ${currentConvId} via middleware...`);
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/chat/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: "test",
          role: "user",
          content: userMessage,
          conversation_id: currentConvId 
        }),
      });

      if (response.status === 504) {
         throw new Error("Human assistance took too long. Please try sending again.");
      } else if (response.status === 429) {
         throw new Error("Assistant is busy with a previous request. Please wait.");
      } else if (!response.ok) {
        const errorData = await response.text();
        console.error("Send Error Response:", errorData);
        throw new Error(`Failed to get response (Status: ${response.status})`);
      }

      const data = await response.json();
      console.log("Received response via middleware:", data);

      if (data.message) {
        const assistantMessage = {
          id: `assistant-${Date.now()}`, 
          conversation_id: data.conversation_id || currentConvId, 
          author_type: "assistant",
          message: data.message.content,
          chatbot_label: data.handoff?.chatbot_label || data.message.chatbot_label || "unknown", 
          created_at: new Date().toISOString()
        };
       
         setMessages(prev => [
           ...prev.filter(msg => msg.id !== tempUserMessage.id || !msg.isOptimistic), 
           tempUserMessage, 
           assistantMessage 
        ]);

      } else {
         console.warn("Response received, but no message content found:", data);
      }
    } catch (error) {
      console.error("Sending message failed:", error);
      setMessages(prev => prev.filter(msg => msg.id !== tempUserMessage.id));
      toast({
        title: "Error",
        description: error.message || "Failed to send message. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = async () => {
    console.log("Restarting chat via middleware...");
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/chat/restart`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: "test", 
        }),
      });

      if (!response.ok) {
         const errorData = await response.text();
         console.error("Restart Error Response:", errorData);
         throw new Error(`Failed to restart chat (Status: ${response.status})`);
      }

      const data = await response.json();
      console.log("Restart Response Data:", data);
      setConversationId(data.conversation_id);
      const newMessages = data.history || []; 
      setMessages(newMessages); 
      console.log("Messages state set to:", newMessages); 
      setInput("");
      console.log("Restart successful, New Conversation ID:", data.conversation_id);
      setConversationId(data.conversation_id);
      setMessages(data.history || []); 
      setInput(""); 

      toast({
        title: "Pavyko",
        description: "Pokalbis buvo pakeistas nauju.",
      });
    } catch (error) {
      console.error("Restarting chat failed:", error);
      toast({
        title: "Klaida",
        description: `Nepavyko pakeisti pokalbio: ${error.message}.`,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-4xl pt-8 pb-32">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-2xl font-bold">Pokalbio langas (klientas)</h1>
          <Button
            onClick={handleRestart}
            variant="outline"
            disabled={loading}
            className="gap-2"
          >
            <RotateCcw className="h-4 w-4" />
            Ištrinti pokalbį
          </Button>
        </div>


        <div className="message-container border border-border rounded-lg p-4 h-[70vh] overflow-y-auto mb-4 bg-muted/40">
          <AnimatePresence>
            {messages.map((message) => (
              <ChatMessage key={message.id || message.created_at} message={message} />
            ))}
          </AnimatePresence>
          <div ref={messagesEndRef} /> 
          {loading && messages.length > 0 && messages[messages.length -1].author_type === 'user' && (
            <div className="text-muted-foreground text-sm italic px-2 py-1">Laukti...</div>
          )}
        </div>

        <ChatInput
          input={input}
          setInput={setInput}
          handleSend={handleSend}
          loading={loading}
        />
      </div>
      <Toaster />
    </div>
  );
}