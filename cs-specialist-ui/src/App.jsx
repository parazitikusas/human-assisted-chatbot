import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './App.css';

// --- Configuration ---
const MIDDLEWARE_API_URL = 'http://localhost:5001'; // Middleware API URL
const POLLING_INTERVAL_MS = 5000; // Check for pending reviews every 5 seconds

function App() {
  const [conversationId, setConversationId] = useState(null);
  const [history, setHistory] = useState([]);
  const [pendingReview, setPendingReview] = useState(null); 
  const [editedContent, setEditedContent] = useState('');
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [historyError, setHistoryError] = useState(null); 
  const [lastPollStatus, setLastPollStatus] = useState('');
  const [feedbackText, setFeedbackText] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerationRequested, setRegenerationRequested] = useState(false); 

  const historyEndRef = useRef(null); //


  const fetchHistory = useCallback(async () => {
    const currentId = conversationId;

    if (!currentId) {
      setHistory(prev => (prev.length > 0 ? [] : prev));
      return;
    }
    if (isLoadingHistory) {
      return;
    }

    console.log(`CS UI: Fetching history for ${currentId}`);
    setIsLoadingHistory(true);
    setHistoryError(null);
    try {
      const response = await axios.get(`${MIDDLEWARE_API_URL}/api/history/messages?conversation_id=${currentId}`);
      if (response.data && response.data.status === 'success') {
        const fetchedData = response.data.data || [];
        setHistory(prevHistory => {
            if (JSON.stringify(fetchedData) !== JSON.stringify(prevHistory)) {
                console.log("CS UI: History updated.");
                return fetchedData;
            }
            return prevHistory;
        });
      } else {
         throw new Error(response.data?.message || 'Failed to fetch history with success status');
      }
    } catch (err) {
      console.error("Error fetching history:", err);
      setHistoryError(`Error fetching history: ${err.message}`);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [conversationId]);


       
  const fetchPendingReview = useCallback(async () => {
    setLastPollStatus(`Atnaujinta ${new Date().toLocaleTimeString()}...`);
    try {
      const response = await axios.get(`${MIDDLEWARE_API_URL}/api/cs/pending_review`);
      const data = response.data;
      const fetchedConvIdFromPoll = data.currentConversationId; // ID reported by middleware this poll

      setConversationId(prevId => {
          if (fetchedConvIdFromPoll && fetchedConvIdFromPoll !== prevId) {
              console.log(`CS UI: Syncing conversation ID from middleware: ${fetchedConvIdFromPoll}`);
              setPendingReview(null);
              setHistory([]);
              setIsRegenerating(false);
              setRegenerationRequested(false);
              return fetchedConvIdFromPoll;
          }
          if (!fetchedConvIdFromPoll && prevId) {
              console.log("CS UI: Middleware reports no active conversation ID. Clearing local ID.");
              setPendingReview(null);
              setHistory([]);
              setIsRegenerating(false);
              setRegenerationRequested(false);
              return null;
          }
          return prevId; 
      });
 
      if (data.hasPending) {
        const newBotResponseData = data.bot_response; 

        setPendingReview(prevReview => {
          let shouldUpdateState = false;
          const isNewlyPending = !prevReview && newBotResponseData;
          const prevContent = prevReview?.bot_response?.message?.content;
          const newContent = newBotResponseData?.message?.content;
          const contentChanged = newContent !== prevContent;
          const wasJustRegenerated = newBotResponseData?.regenerated_with_feedback && !prevReview?.bot_response?.regenerated_with_feedback;

          if (isNewlyPending || contentChanged || wasJustRegenerated) {
            shouldUpdateState = true;
          }

          if (shouldUpdateState) {
              console.log("CS UI: Updating pending review state:", newBotResponseData);
              const initialContent = newBotResponseData?.message?.content || '';
              setEditedContent(initialContent); // Update the manual edit box content
              setLastPollStatus(`Laukiama patvirtinimo pokalbiui ${fetchedConvIdFromPoll} ${new Date().toLocaleTimeString()}`);

              if (isNewlyPending) {
                  console.log("CS UI: New review became pending, triggering immediate history fetch.");

                  fetchHistory();
              }

              if (regenerationRequested && wasJustRegenerated) {
                  console.log("CS UI: Detected updated regenerated response. Re-enabling UI.");
                  setIsRegenerating(false); // Re-enable buttons now that update is reflected
                  setRegenerationRequested(false); // Reset the request flag
              }

              return data; 
          } else {
              setLastPollStatus(`Laukiama patvirtinimo pokalbiui ${fetchedConvIdFromPoll} ${new Date().toLocaleTimeString()}`);
              if (regenerationRequested) { /* console.log("...") */ } // Keep UI disabled if waiting for regen
              return prevReview; // Keep the previous state
          }
        });
      } else {

        setPendingReview(prevReview => {
            if (prevReview) {
                console.log("CS UI: Pending review resolved or none found by middleware.");
                setEditedContent('');
                return null;
            }
            return prevReview;
        });
        setLastPollStatus(`Nėra laukiančių užklausų ${new Date().toLocaleTimeString()}. Pokalbio ID: ${fetchedConvIdFromPoll || 'None'}`);

        if(isRegenerating || regenerationRequested) {
            console.log("CS UI: No pending review, resetting any lingering regeneration state.");
            setIsRegenerating(false);
            setRegenerationRequested(false);
        }
      }

      setError(null);

    } catch (err) {
        console.error("Error polling for pending review:", err);
        setError(`Error polling: ${err.message}. Is the middleware running?`);
        setLastPollStatus(`Polling Error at ${new Date().toLocaleTimeString()}`);
        if(isRegenerating || regenerationRequested) {
            console.log("CS UI: Poll error, resetting any lingering regeneration state.");
            setIsRegenerating(false);
            setRegenerationRequested(false);
        }
    }
  }, [conversationId, pendingReview, regenerationRequested, isRegenerating, fetchHistory]); 

  


  const handleRegenerate = async () => {
    if (!pendingReview || isRegenerating || isSubmitting || !feedbackText.trim()) {
        if (!feedbackText.trim()) {
            setError("Please enter feedback/instructions before regenerating.");
        }
        return;
    }

    setIsRegenerating(true); 
    setRegenerationRequested(true); 
    setError(null);
    setHistoryError(null);
    console.log("CS UI: Requesting regeneration with feedback:", feedbackText);

    try {
        const response = await axios.post(`${MIDDLEWARE_API_URL}/api/cs/regenerate_response`, {
             feedback: feedbackText
        });

        if (response.status === 200) {
            console.log("CS UI: Regeneration request successful. Waiting for poll update.");
            setFeedbackText(''); 
            setLastPollStatus("Regeneration requested. Waiting for updated response...");
        } else {
             throw new Error(response.data?.message || `Regeneration request failed with status ${response.status}`);
        }

    } catch (err) {
        console.error("Error requesting regeneration:", err);
        setError(`Regeneration failed: ${err.response?.data?.message || err.message}`);
        setLastPollStatus("Regeneration request failed.");
        setIsRegenerating(false);
        setRegenerationRequested(false); 
    }
  };

  const handleSubmit = async () => {
    const currentReviewData = pendingReview;
    const currentConvId = conversationId;

    if (!currentReviewData || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    setHistoryError(null);

    const finalResponsePayload = {
       ...currentReviewData.bot_response,
       message: {
           ...currentReviewData.bot_response.message,
           content: editedContent,
       },
       conversation_id: currentReviewData.conversation_id || currentConvId,
    };
    console.log("Submitting edited response:", finalResponsePayload);

    try {
      const response = await axios.post(`${MIDDLEWARE_API_URL}/api/cs/submit_response`, {
        edited_response: finalResponsePayload
      });
      if (response.status === 200) {
        console.log("Submission successful");
        setPendingReview(null);
        setEditedContent('');
        console.log("Triggering history fetch after successful submission.");
        fetchHistory(); 
      } else {
         throw new Error(response.data?.message || `Submit request failed with status ${response.status}`);
      }
    } catch (err) {
      console.error("Error submitting response:", err);
      setError(`Error submitting: ${err.response?.data?.error || err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };



//Poll for pending reviews and update relevant state
  useEffect(() => {
    console.log("CS UI: Setting up polling interval.");
    fetchPendingReview(); // Initial poll check on mount
    const intervalId = setInterval(
      fetchPendingReview, POLLING_INTERVAL_MS);
    return () => {
        console.log("CS UI: Clearing polling interval.");
        clearInterval(intervalId);
    };
  }, [fetchPendingReview]); 



//Fetch history whenever conversationId changes state
  useEffect(() => {
    if (conversationId) {
        console.log(`CS UI: conversationId state changed to ${conversationId}, triggering fetchHistory.`);
        fetchHistory(); 
    } else {
        console.log("CS UI: conversationId is null, clearing/skipping history fetch.");
        setHistory([]); 
    }
  }, [conversationId]); 


//Scroll to bottom of history when it updates
  useEffect(() => {
    if(history.length > 0) {
        const timer = setTimeout(() => {
             historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }, 100);
        return () => clearTimeout(timer);
    }
  }, [history]);


  return (
    <div className="App">
      <h1>Specialisto skydelis</h1>
      <div className="status-bar">Paskutinis atnaujinimas: {lastPollStatus}</div>
      {(error || historyError) && <div className="error-message">Klaida: {error || historyError}</div>}

      <div className="main-layout">
        {/* Chat History Section */}
        <div className="history-panel">
          <h2>Pokalbio istorija</h2>
          {conversationId ? (
            <p>Pokalbio ID: <strong>{conversationId}</strong></p>
          ) : (
            <p>Laukiama, kol pokalbis bus perduotas į peržiūros režimą...</p> // Updated text
          )}
          {isLoadingHistory && <p>Pokalbio istorija kraunama...</p>}
          <div className="message-list">
            {history.map((msg) => (
              <div key={msg.id || `${msg.author_type}-${msg.created_at}`} className={`message ${msg.author_type} ${msg.isEdited ? 'edited' : ''}`}>
                <span className="author">{msg.author_type}:</span>
                <span className="content">{typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message)}</span>
                <span className="timestamp">{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                {msg.isEdited && <span className="edited-indicator">(Edited)</span>}
              </div>
            ))}
            <div ref={historyEndRef} />
          </div>
           {/* Manual refresh button */}
           <button onClick={fetchHistory} disabled={!conversationId || isLoadingHistory}>
             Atnaujinti pokalbio istoriją
           </button>
        </div>

        {/* Pending Review Section */}
        <div className="review-panel">
        <h2>Užklausa, laukianti patvirtinimo:</h2>
          {pendingReview ? (
            <div className="review-box">
              {/* Manual Edit Area */}
              <p><strong>Rankinis žinutės redagavimas</strong></p>
              <textarea
                value={editedContent}
                onChange={(e) => setEditedContent(e.target.value)}
                placeholder="Redaguoti žinutę renkiniu būdu čia"
                rows={8}
                disabled={isSubmitting || isRegenerating}
              />
              <button
                 onClick={handleSubmit}
                 disabled={isSubmitting || isRegenerating || !editedContent.trim()} 
                 style={{ marginRight: '10px' }}
               >
                {isSubmitting ? 'Siunčiama...' : 'Patvirtinti ir išsiųsti'}
              </button>

              <hr style={{ margin: '15px 0' }}/>

              <p><strong>Redaguoti žinutę su DI</strong></p>
               <textarea
                 value={feedbackText}
                 onChange={(e) => setFeedbackText(e.target.value)}
                 placeholder="Pateikite komentarus DI generavimui (pvz., 'Padaryk, kad skambėtų empatiškiau')..."
                 rows={3}
                 disabled={isSubmitting || isRegenerating}
                 style={{ marginBottom: '10px' }}
               />
              <button onClick={handleRegenerate} disabled={isSubmitting || isRegenerating || !feedbackText.trim()}>
                {isRegenerating ? 'Generuojama...' : 'Generuoti su DI'}
              </button>

            </div>
          ) : (
            <p>Kolkas nėra užklausų, laukiančių peržiūros.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;