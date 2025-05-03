
import React from "react";
import { Button } from "@/components/ui/button";
import { Send } from "lucide-react";

export function ChatInput({ input, setInput, handleSend, loading }) {
  return (
    <div className="chat-input">
      <div className="container mx-auto max-w-4xl">
        <div className="flex gap-4">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === "Enter" && handleSend()}
            placeholder="Rašykite žinutę..."
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            disabled={loading}
          />
          <Button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="gap-2"
          >
            <Send className="h-4 w-4" />
            Siųsti
          </Button>
        </div>
      </div>
    </div>
  );
}
