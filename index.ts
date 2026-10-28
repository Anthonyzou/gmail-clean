import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import { google } from 'googleapis';

import { authorize, classifyEmail, getOrCreateLabelId } from './utils.ts';

/**
 * Main Processing Loop
 */
async function run() {
  const auth = await authorize();
  const gmail = google.gmail({ version: 'v1', auth });
  const removalSureID = await getOrCreateLabelId(gmail, 'AI_REMOVAL_SURE');
  const removalUnSureID = await getOrCreateLabelId(gmail, 'AI_REMOVAL_UNSURE');
  const receiptsLabelId = await getOrCreateLabelId(gmail, 'Receipts');
  const aiRead = await getOrCreateLabelId(gmail, 'Proccessed');
  const updates = 'CATEGORY_UPDATES';

  console.log('\nFetching unread promotional emails...');

  let pageToken = undefined;
  try {
    const t = fs.readFileSync('page').toString();
    if (t.length > 0) {
      pageToken = t;
      console.log('updated token to ', t);
    }
  } catch (e) {}

  let pageNumber = 0;
  let totalProcessed = 0;

  // Set safety cap so you don't accidentally process 50,000 emails on first run
  const MAX_PAGES = 100; // Adjust as needed
  const PAGE_SIZE = 30; // 1 to 500 (50 is a sweet spot for rate limits)

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'category:updates -label:trades -label:Prades',
      maxResults: PAGE_SIZE, // Start with small batches
      pageToken: pageToken,
    });
    pageToken = res.data.nextPageToken;

    const messages = res.data.messages || [];
    if (messages.length === 0) {
      console.log('No messages found matching criteria.');
      return;
    }

    const processed: {
      id: string;
      fromHeader: string;
      subject: string;
      snippet: string;
      action: string;
    }[] = [];
    for (let msg of messages) {
      // 1. Fetch metadata only (fast & private, no full body download)
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject'],
      });

      const headers = detail.data.payload.headers || [];
      const fromHeader =
        headers.find((h) => h.name === 'From')?.value || 'Unknown';
      const subject =
        headers.find((h) => h.name === 'Subject')?.value || 'No Subject';
      const snippet = detail.data.snippet || '';

      processed.push({
        id: msg.id,
        fromHeader,
        subject,
        snippet,
        action: '',
      });
    }

    if (processed.length == 0) {
      console.log('no emails found this page continuing');
      continue;
    }

    console.log(
      `Processing ${messages.length} messages from ${pageToken}...\n`,
    );

    // 2. Classify with LLM
    const result = await classifyEmail(processed, process.env.ROUTER_API_KEY!);
    let verdicts = [];
    try {
      verdicts = JSON.parse(result);
      console.log('AI RESULTS: ', result.length);
      verdicts.map((i) => 1);
    } catch (e) {
      console.log(result);
    }

    const receipts: string[] = [];
    const sure_delete: string[] = [];
    const un_sure_delete: string[] = [];

    verdicts.map((data) => {
      const { action, id } = data;
      const { subject, fromHeader } = processed.find((i) => i.id == id) || {};
      console.log(
        `[${action}] -> "${(subject || '').substring(0, 45)}..." (${(fromHeader || '').substring(0, 25)})`,
      );
      // 3. Take Action
      if (action === 'RECEIPTS') {
        receipts.push(id);
      }
      if (action === 'SURE_DELETE') {
        sure_delete.push(id);
      }
      if (action === 'UN_SURE_DELETE') {
        un_sure_delete.push(id);
      }

      return id;
    });

    if (receipts.length > 0)
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: receipts,
          addLabelIds: [receiptsLabelId], // 👈 Stamps the RECEIPTS label
          removeLabelIds: [updates],
        },
      });

    if (sure_delete.length > 0)
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: sure_delete,
          addLabelIds: [removalSureID], // 👈 Stamps the AI_REMOVAL label
        },
      });

    if (un_sure_delete.length > 0)
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: un_sure_delete,
          addLabelIds: [removalUnSureID], // 👈 Stamps the AI_REMOVAL label
        },
      });

    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: processed.map((i) => i.id),
        addLabelIds: [aiRead], // Stamp that this email has been processed
      },
    });

    console.log(pageToken);
    fs.writeFileSync('page', pageToken);
    totalProcessed += verdicts.length;
    const date = new Date();
    console.log(
      totalProcessed,
      pageNumber,
      new Date().toDateString() + ' ' + date.toLocaleTimeString(),
    );
    pageNumber++;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (pageToken && pageNumber < MAX_PAGES);

  console.log('\nBatch complete!');
}

run().catch(console.error);
