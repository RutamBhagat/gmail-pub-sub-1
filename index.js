require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const axios = require("axios");

const PORT = process.env.PORT;
const app = express();

// --- Global variables for tokens and history ---
// IMPORTANT: In production, store these securely and per-user if managing multiple accounts.
let currentAccessToken = null;
let currentRefreshToken = null; // To store the refresh token
let lastProcessedHistoryIdByUser = {}; // { "user@example.com": "historyId" }

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
      console.log("Refresh Token: ", refreshToken); // Will be undefined after the first auth unless forced
      console.log(
        "Profile Email: ",
        profile.emails && profile.emails[0]
          ? profile.emails[0].value
          : "No email"
      );

      currentAccessToken = accessToken;
      if (refreshToken) {
        // Only store/update refresh token if a new one is provided
        currentRefreshToken = refreshToken;
        console.log("Stored new Refresh Token.");
      }

      const userEmail =
        profile.emails && profile.emails[0] && profile.emails[0].value;
      if (userEmail && !lastProcessedHistoryIdByUser[userEmail]) {
        // Ideally, get the initial historyId from the users.watch() response.
        // For now, we'll let the first webhook populate it.
        console.log(`Initial authentication for ${userEmail}.`);
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
      "https://www.googleapis.com/auth/gmail.readonly", // For history.list and messages.get
      "https://www.googleapis.com/auth/gmail.modify", // If you ever need to modify
      "https://www.googleapis.com/auth/gmail.labels", // For label info
    ],
    accessType: "offline", // Important: Asks for a refresh token
    prompt: "consent", // Forces consent screen & new refresh token (useful for testing this)
  })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login",
    session: false,
  }),
  (req, res) => {
    console.log(
      "Authentication successful. Tokens captured in strategy callback."
    );
    res.send(
      "Authentication successful! You can close this tab. Access and Refresh tokens (if new) logged in server console."
    );
  }
);

// Helper function to get a new access token using the refresh token
async function refreshAccessToken() {
  if (!currentRefreshToken) {
    console.error("No refresh token available to refresh access token.");
    return null;
  }
  console.log("Attempting to refresh access token...");
  try {
    const response = await axios.post(
      "https://oauth2.googleapis.com/token",
      null,
      {
        // Body is null, params are used for x-www-form-urlencoded
        params: {
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: currentRefreshToken,
          grant_type: "refresh_token",
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    currentAccessToken = response.data.access_token;
    console.log("Access token refreshed successfully.");
    // Google might issue a new refresh token, but often doesn't if the old one is still valid.
    // If response.data.refresh_token exists, you should update currentRefreshToken.
    if (response.data.refresh_token) {
      currentRefreshToken = response.data.refresh_token;
      console.log("Received and updated a new refresh token.");
    }
    return currentAccessToken;
  } catch (error) {
    console.error(
      "Error refreshing access token:",
      error.response ? JSON.stringify(error.response.data) : error.message
    );
    currentAccessToken = null; // Invalidate on failure
    currentRefreshToken = null; // If refresh token is bad, clear it too
    return null;
  }
}

// Wrapper for Gmail API calls with token refresh and retry
async function callGmailApi(url, config, retryCount = 0) {
  if (!currentAccessToken) {
    console.log("No current access token, trying to refresh...");
    await refreshAccessToken();
    if (!currentAccessToken) {
      throw new Error("Failed to obtain access token after refresh attempt.");
    }
  }

  const requestConfig = {
    ...config,
    headers: {
      ...config.headers,
      Authorization: `Bearer ${currentAccessToken}`,
      "Content-Type": "application/json",
    },
  };

  try {
    return await axios(url, requestConfig);
  } catch (error) {
    if (error.response && error.response.status === 401 && retryCount < 1) {
      console.log("Received 401, attempting token refresh and retry...");
      await refreshAccessToken(); // Attempt to refresh
      if (currentAccessToken) {
        return callGmailApi(url, config, retryCount + 1); // Retry once
      } else {
        console.error("Failed to refresh token, cannot retry API call.");
        throw error; // Re-throw original error or a new one
      }
    } else {
      throw error; // Re-throw for other errors or if retries exhausted
    }
  }
}


app.post("/webhook/gmail", async (req, res) => {
  console.log("\n--- Gmail Webhook Received (Pub/Sub Notification) ---");
  res.status(200).send("OK");

  const { message: pubSubMessage } = req.body;
  if (!pubSubMessage || !pubSubMessage.data) {
    console.log("No message.data in Pub/Sub. Ending processing.");
    return;
  }

  let decodedPubSubPayload;
  try {
    decodedPubSubPayload = JSON.parse(
      Buffer.from(pubSubMessage.data, "base64").toString("utf-8")
    );
    console.log("Decoded Pub/Sub Payload:", decodedPubSubPayload);
  } catch (error) {
    console.error("Error decoding Pub/Sub payload:", error);
    return;
  }

  const { emailAddress, historyId: notifiedHistoryId } = decodedPubSubPayload;
  if (!emailAddress) {
    console.error("No emailAddress in Pub/Sub payload.");
    return;
  }

  const startHistoryId =
    lastProcessedHistoryIdByUser[emailAddress] || notifiedHistoryId;
  console.log(
    `Processing for ${emailAddress}, starting from historyId: ${startHistoryId}`
  );

  try {
    const historyListResponse = await callGmailApi(
      `https://gmail.googleapis.com/gmail/v1/users/${emailAddress}/history`,
      {
        method: "get",
        params: { startHistoryId, historyTypes: "messageAdded" },
      }
    );

    const historyData = historyListResponse.data;
    let newHistoryIdToStore = historyData.historyId;

    if (historyData.history) {
      for (const historyItem of historyData.history) {
        if (historyItem.messagesAdded) {
          for (const addedMsgContainer of historyItem.messagesAdded) {
            const messageSummary = addedMsgContainer.message;
            if (messageSummary && messageSummary.id) {
              console.log(
                `\nFound new message. ID: ${
                  messageSummary.id
                }, Initial Labels from history: ${
                  messageSummary.labelIds
                    ? messageSummary.labelIds.join(", ")
                    : "N/A"
                }`
              );

              try {
                const messageDetailsResponse = await callGmailApi(
                  `https://gmail.googleapis.com/gmail/v1/users/${emailAddress}/messages/${messageSummary.id}`,
                  {
                    method: "get",
                    // UPDATED FIELDS:
                    params: {
                      fields:
                        "id,labelIds,snippet,payload(headers,parts(mimeType,filename,body(data),parts(mimeType,filename,body(data))))",
                    },
                  }
                );
                const fullMessageDetails = messageDetailsResponse.data;

                let subject = "No Subject";
                if (
                  fullMessageDetails.payload &&
                  fullMessageDetails.payload.headers
                ) {
                  const subjectHeader = fullMessageDetails.payload.headers.find(
                    (h) => h.name.toLowerCase() === "subject"
                  );
                  if (subjectHeader) {
                    subject = subjectHeader.value;
                  }
                }

                console.log(`  Subject: ${subject}`);
                console.log(`  Snippet: ${fullMessageDetails.snippet}`);
                console.log(
                  `  Final Labels: ${fullMessageDetails.labelIds.join(", ")}`
                );

                // --- Find and decode the plain text body ---
                let plainTextBody = "";
                if (fullMessageDetails.payload) {
                  // Recursive function to find the text/plain part
                  function findPlainTextPart(part) {
                    if (
                      part.mimeType === "text/plain" &&
                      part.body &&
                      part.body.data
                    ) {
                      return Buffer.from(part.body.data, "base64").toString(
                        "utf-8"
                      );
                    }
                    if (part.parts && part.parts.length > 0) {
                      for (const subPart of part.parts) {
                        const foundBody = findPlainTextPart(subPart);
                        if (foundBody) return foundBody;
                      }
                    }
                    return null; // Return null if no text/plain part with data is found
                  }
                  plainTextBody = findPlainTextPart(fullMessageDetails.payload);
                }

                if (plainTextBody) {
                  // console.log("  Decoded Plain Text Body (first 500 chars):", plainTextBody.substring(0, 500)); // Log part of it

                  // ** YOUR LOGIC HERE: Check body for prefix-uuid **
                  const bodyPrefix = "spam-test-"; // Define your prefix
                  const indexOfPrefix = plainTextBody.indexOf(bodyPrefix);

                  if (indexOfPrefix !== -1) {
                    // Extract the part after the prefix
                    const potentialUuidAndRest = plainTextBody.substring(
                      indexOfPrefix + bodyPrefix.length
                    );
                    // A simple way to get what might be the UUID (assuming it's the next word or up to a space/newline)
                    const potentialUuid =
                      potentialUuidAndRest.split(/[\s\n,.]+/)[0];

                    const uuidRegex =
                      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
                    if (uuidRegex.test(potentialUuid)) {
                      console.log(
                        `  MATCH IN BODY: Found prefix '${bodyPrefix}' with UUID: ${potentialUuid}`
                      );
                      // Add to your DB or further processing here
                    } else {
                      console.log(
                        `  INFO IN BODY: Found prefix '${bodyPrefix}', but '${potentialUuid}' doesn't look like a UUID.`
                      );
                    }
                  } else {
                    console.log(
                      `  INFO IN BODY: Prefix '${bodyPrefix}' not found in body.`
                    );
                  }
                } else {
                  console.log(
                    "  No plain text body found or body data was empty."
                  );
                }
                // --- End of body processing ---

                if (
                  fullMessageDetails.labelIds &&
                  fullMessageDetails.labelIds.includes("SPAM")
                ) {
                  console.log(
                    `  ALERT: Message ${messageSummary.id} is in SPAM.`
                  );
                }
                if (
                  fullMessageDetails.labelIds &&
                  fullMessageDetails.labelIds.includes("TRASH")
                ) {
                  console.log(
                    `  ALERT: Message ${messageSummary.id} is in TRASH.`
                  );
                }
              } catch (msgError) {
                console.error(
                  `  Error fetching details for message ${messageSummary.id}:`,
                  msgError.response
                    ? JSON.stringify(msgError.response.data)
                    : msgError.message
                );
              }
            }
          }
        }
      }
    } else {
      console.log("No new history entries found.");
    }

    if (newHistoryIdToStore) {
      lastProcessedHistoryIdByUser[emailAddress] = newHistoryIdToStore;
      console.log(
        `\nUpdated lastProcessedHistoryId for ${emailAddress} to: ${newHistoryIdToStore}`
      );
    }
  } catch (apiError) {
    console.error(
      "Critical Error processing webhook batch:",
      apiError.response
        ? JSON.stringify(apiError.response.data)
        : apiError.message
    );
  }
  console.log("--- Webhook Processing Finished ---");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(
    `To get tokens, authenticate at: http://localhost:${PORT}/auth/google`
  );
});
