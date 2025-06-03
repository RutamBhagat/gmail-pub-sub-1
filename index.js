require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const axios = require("axios");

const PORT = process.env.PORT;
const app = express();

/**
 * Global variables for OAuth tokens and email processing state.
 * In production, store these securely and per-user for multiple accounts.
 */
let currentAccessToken = null;
let currentRefreshToken = null;
let lastProcessedHistoryIdByUser = {};

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
      console.log("Refresh Token: ", refreshToken);
      console.log(
        "Profile Email: ",
        profile.emails && profile.emails[0]
          ? profile.emails[0].value
          : "No email"
      );

      currentAccessToken = accessToken;
      if (refreshToken) {
        currentRefreshToken = refreshToken;
        console.log("Stored new Refresh Token.");
      }

      const userEmail =
        profile.emails && profile.emails[0] && profile.emails[0].value;
      if (userEmail && !lastProcessedHistoryIdByUser[userEmail]) {
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
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.labels",
    ],
    accessType: "offline",
    prompt: "consent",
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

/**
 * Refreshes the OAuth access token using the stored refresh token.
 * Returns the new access token or null if refresh fails.
 */
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
    currentAccessToken = null;
    currentRefreshToken = null;
    return null;
  }
}

/**
 * Wrapper for Gmail API calls with automatic token refresh and retry on 401 errors.
 */
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
      await refreshAccessToken();
      if (currentAccessToken) {
        return callGmailApi(url, config, retryCount + 1);
      } else {
        console.error("Failed to refresh token, cannot retry API call.");
        throw error;
      }
    } else {
      throw error;
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

  const matchedEmailsForLog = [];

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

                let plainTextBody = "";
                if (fullMessageDetails.payload) {
                  /**
                   * Recursively searches through email parts to find plain text content.
                   */
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
                    return null;
                  }
                  plainTextBody = findPlainTextPart(fullMessageDetails.payload);
                }

                if (plainTextBody) {
                  const bodyPrefix = "spam-test-";
                  const indexOfPrefix = plainTextBody.indexOf(bodyPrefix);

                  if (indexOfPrefix !== -1) {
                    const potentialUuidAndRest = plainTextBody.substring(
                      indexOfPrefix + bodyPrefix.length
                    );
                    const potentialUuid =
                      potentialUuidAndRest.split(/[\s\n,.]+/)[0];
                    const uuidRegex =
                      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

                    if (uuidRegex.test(potentialUuid)) {
                      console.log(
                        `  MATCH IN BODY: Found prefix '${bodyPrefix}' with UUID: ${potentialUuid}`
                      );
                      matchedEmailsForLog.push({
                        id: `${bodyPrefix}${potentialUuid}`,
                        labels: fullMessageDetails.labelIds || [],
                      });
                    } else {
                      console.log(
                        `  INFO IN BODY: Found prefix '${bodyPrefix}', but '${potentialUuid}' doesn't look like a UUID.`
                      );
                    }
                  }
                }

                if (
                  fullMessageDetails.labelIds &&
                  fullMessageDetails.labelIds.includes("SPAM")
                ) {
                  console.log(
                    `  ALERT: Message ${messageSummary.id} (Subject: ${subject}) is in SPAM.`
                  );
                }
                if (
                  fullMessageDetails.labelIds &&
                  fullMessageDetails.labelIds.includes("TRASH")
                ) {
                  console.log(
                    `  ALERT: Message ${messageSummary.id} (Subject: ${subject}) is in TRASH.`
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
      console.log("No new history entries found in this batch.");
    }

    if (matchedEmailsForLog.length > 0) {
      console.log("\n=== Matched Emails (Structured Log) ===");
      console.log(JSON.stringify(matchedEmailsForLog, null, 2));
      console.log("======================================");
    } else {
      console.log(
        "\nNo emails matched the prefix-UUID criteria in this batch."
      );
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
