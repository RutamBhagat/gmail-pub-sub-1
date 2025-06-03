// ... (all previous code: require statements, global token variables, passport setup, auth routes, refreshAccessToken, callGmailApi) ...

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

  const matchedEmailsForLog = []; // <--- Initialize array to store matched email data

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
                // console.log(`  Snippet: ${fullMessageDetails.snippet}`); // Optional: keep for debugging
                // console.log(`  Final Labels: ${fullMessageDetails.labelIds.join(', ')}`); // Optional: keep for debugging

                let plainTextBody = "";
                if (fullMessageDetails.payload) {
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
                      // Add to our log array
                      matchedEmailsForLog.push({
                        id: potentialUuid, // This is your extracted prefix-uuid
                        labels: fullMessageDetails.labelIds || [], // Ensure labels is always an array
                      });
                    } else {
                      console.log(
                        `  INFO IN BODY: Found prefix '${bodyPrefix}', but '${potentialUuid}' doesn't look like a UUID.`
                      );
                    }
                  } else {
                    // console.log(`  INFO IN BODY: Prefix '${bodyPrefix}' not found in body.`); // Optional log
                  }
                } else {
                  // console.log("  No plain text body found or body data was empty."); // Optional log
                }

                // Example of logging if it lands in SPAM or TRASH (can be part of your main logic)
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

    // --- Log the structured JSON array if any matches were found ---
    if (matchedEmailsForLog.length > 0) {
      console.log("\n=== Matched Emails (Structured Log) ===");
      console.log(JSON.stringify(matchedEmailsForLog, null, 2));
      console.log("======================================");
    } else {
      console.log(
        "\nNo emails matched the prefix-UUID criteria in this batch."
      );
    }
    // --- End of structured JSON logging ---

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

// ... (app.listen and rest of the file remains the same) ...
