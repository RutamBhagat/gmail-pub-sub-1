require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const axios = require("axios"); // <-- Import axios

const PORT = process.env.PORT;
const app = express();

// --- Global variable to store the access token and last history ID ---
// IMPORTANT: In a real application, store tokens securely (e.g., database)
// and implement refresh token logic. lastProcessedHistoryId should also be stored per user.
let currentAccessToken = null;
let lastProcessedHistoryIdByUser = {}; // Store as { emailAddress: historyId }

app.use(
  bodyParser.json({
    limit: "50mb",
    verify: (req, _, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(passport.initialize());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    (accessToken, refreshToken, profile, done) => {
      console.log("Access Token: ", accessToken);
      console.log("Refresh Token: ", refreshToken); // Store this securely for long-term access
      console.log("Profile: ", profile);

      currentAccessToken = accessToken; // Store access token for webhook use
      const userEmail =
        profile.emails && profile.emails[0] && profile.emails[0].value;
      if (userEmail && !lastProcessedHistoryIdByUser[userEmail]) {
        // For simplicity, we're not fetching the initial historyId from watch() here.
        // The first webhook will use the notified historyId, which is okay for a start.
        // A robust app would get the historyId from the users.watch response.
        console.log(
          `Access token obtained for ${userEmail}. Webhook can now fetch history.`
        );
      }
      done(null, profile);
    }
  )
);

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: [
      "profile",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.labels",
    ],
    accessType: "offline", // Request offline access to get a refresh token
    prompt: "consent", // Consider 'consent' to force refresh token on re-auth if needed
  })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login",
    session: false,
  }),
  (req, res) => {
    // The accessToken is now stored in currentAccessToken via the strategy callback
    console.log("Authentication successful. Access token captured.");
    res.redirect("/"); // Or redirect to a success page
  }
);

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.get("/", (req, res) => {
  res.send("Home. Authenticate at /auth/google. Webhook at /webhook/gmail");
});

// Make the webhook handler async to use await for API calls
app.post("/webhook/gmail", async (req, res) => {
  console.log("Gmail Webhook Received (Pub/Sub Notification)");

  // Acknowledge Pub/Sub immediately to prevent retries
  res.status(200).send("OK");

  console.log("Raw Pub/Sub Body:", req.body);

  const { message } = req.body;

  if (!message || !message.data) {
    console.log("No message.data found in Pub/Sub notification.");
    return;
  }

  if (!currentAccessToken) {
    console.error(
      "Access Token not available for API calls. Please authenticate via /auth/google first."
    );
    return;
  }

  let decodedPubSubMessage;
  try {
    const encodedMessageData = message.data;
    decodedPubSubMessage = JSON.parse(
      Buffer.from(encodedMessageData, "base64").toString("utf-8")
    );
    console.log("Decoded Pub/Sub Message:", decodedPubSubMessage);
  } catch (error) {
    console.error("Failed to decode Pub/Sub message data:", error);
    return;
  }

  const { emailAddress, historyId: notifiedHistoryId } = decodedPubSubMessage;

  // Use the last processed history ID for this user, or the notified one if none stored yet
  const startHistoryId =
    lastProcessedHistoryIdByUser[emailAddress] || notifiedHistoryId;
  // Note: A more robust way is to get the initial historyId from the users.watch() call response
  // and store it as the first lastProcessedHistoryIdByUser[emailAddress].
  // Using notifiedHistoryId as startHistoryId might re-fetch the triggering event if not careful.
  // For now, to ensure we get *new* items, we usually query *after* our last known point.

  console.log(
    `Fetching history for ${emailAddress} starting with historyId: ${startHistoryId}`
  );

  try {
    // Step 1: Call users.history.list
    const historyListResponse = await axios.get(
      `https://gmail.googleapis.com/gmail/v1/users/${emailAddress}/history`, // Or 'me' if token belongs to this user
      {
        params: {
          startHistoryId: startHistoryId,
          historyTypes: "messageAdded",
        },
        headers: {
          Authorization: `Bearer ${currentAccessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const historyData = historyListResponse.data;
    console.log(
      "users.history.list API Response:",
      JSON.stringify(historyData, null, 2)
    );

    const newMessages = [];
    if (historyData.history) {
      for (const historyItem of historyData.history) {
        if (historyItem.messagesAdded) {
          for (const addedMsg of historyItem.messagesAdded) {
            if (addedMsg.message && addedMsg.message.id) {
              newMessages.push(addedMsg.message.id);
            }
          }
        }
      }
    }

    if (newMessages.length === 0) {
      console.log("No new message IDs found in history list.");
    }

    // Step 2: For each new message ID, call users.messages.get
    for (const messageId of newMessages) {
      console.log(`Fetching details for message ID: ${messageId}`);
      try {
        const messageDetailsResponse = await axios.get(
          `https://gmail.googleapis.com/gmail/v1/users/${emailAddress}/messages/${messageId}`,
          {
            params: {
              fields: "id,labelIds,snippet", // Request only specific fields
            },
            headers: {
              Authorization: `Bearer ${currentAccessToken}`,
              "Content-Type": "application/json",
            },
          }
        );

        const messageDetails = messageDetailsResponse.data;
        console.log(`---- Details for message ${messageId} ----`);
        console.log("Labels:", messageDetails.labelIds);
        console.log("Snippet:", messageDetails.snippet);
        console.log("--------------------------------------");

        // ** YOUR LOGIC HERE **
        // Check messageDetails.snippet for your prefix-uuid
        // Check messageDetails.labelIds to see where it landed (INBOX, SPAM, TRASH, etc.)
        // Example:
        // if (messageDetails.snippet && messageDetails.snippet.includes("YOUR-PREFIX-UUID")) {
        //   console.log(`Found target UUID in message ${messageId}`);
        // }
        // if (messageDetails.labelIds && messageDetails.labelIds.includes("SPAM")) {
        //   console.log(`Message ${messageId} is in SPAM.`);
        // }
      } catch (msgError) {
        console.error(
          `Error fetching details for message ${messageId}:`,
          msgError.response
            ? JSON.stringify(msgError.response.data)
            : msgError.message
        );
      }
    }

    // IMPORTANT: Update the last processed history ID for this user
    // This historyId comes from the end of the users.history.list response.
    if (historyData.historyId) {
      lastProcessedHistoryIdByUser[emailAddress] = historyData.historyId;
      console.log(
        `Updated lastProcessedHistoryId for ${emailAddress} to: ${historyData.historyId}`
      );
    }
  } catch (apiError) {
    console.error(
      "Error calling Gmail API (history.list):",
      apiError.response
        ? JSON.stringify(apiError.response.data)
        : apiError.message
    );
    if (apiError.response && apiError.response.status === 401) {
      console.error(
        "Access Token might be expired or invalid. User needs to re-authenticate via /auth/google."
      );
      currentAccessToken = null; // Clear the potentially invalid token
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Authenticate at: http://localhost:${PORT}/auth/google`);
  console.log(
    `Webhook endpoint: http://localhost:${PORT}/webhook/gmail (needs to be public via ngrok for Pub/Sub)`
  );
});
