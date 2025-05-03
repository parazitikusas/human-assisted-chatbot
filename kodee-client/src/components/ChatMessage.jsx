
import React from "react";
import { motion } from "framer-motion";

export function ChatMessage({ message }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className={`message ${
        message.author_type === "user" ? "user-message" : "assistant-message"
      }`}
    >
      {message.message}
    </motion.div>
  );
}
