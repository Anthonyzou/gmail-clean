import fs from 'fs';
import { Auth, gmail_v1, google } from 'googleapis';

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText } from 'ai';
import path from 'path';
import readline from 'readline';

/**
 * Ensures a label exists and returns its unique ID
 */
export async function getOrCreateLabelId(
  gmail: gmail_v1.Gmail,
  labelName: string,
): Promise<string> {
  // 1. Fetch existing labels
  const res = await gmail.users.labels.list({ userId: 'me' });
  const labels = res.data.labels || [];

  const existing = labels.find(
    (l) => l?.name?.toLowerCase() === labelName.toLowerCase(),
  );
  if (existing?.id) {
    return existing.id;
  }

  // 2. If it doesn't exist, create it
  console.log(`Label "${labelName}" not found. Creating it...`);
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });

  if (!created.data.id) throw new Error('no id found');
  return created.data.id;
}

// Scopes: 'modify' allows labeling & archiving, but NOT permanent deletion.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

/**
 * Handle OAuth2 authorization
 */
export async function authorize(): Promise<Auth.OAuth2Client> {
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  const credentials = JSON.parse(content);
  const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0],
  );

  if (fs.existsSync(TOKEN_PATH)) {
    const token = fs.readFileSync(TOKEN_PATH, 'utf-8');
    oAuth2Client.setCredentials(JSON.parse(token));
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log(
    '\nAuthorize this app by visiting this URL in your browser:\n',
    authUrl,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('\nEnter the code from that page here: ', async (code) => {
      rl.close();
      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
      console.log('Token stored to', TOKEN_PATH);
      resolve(oAuth2Client);
    });
  });
}

/**
 * Classify email with Gemini Flash
 */
export async function classifyEmail(data: any[], apiKey: string) {
  const openrouter = createOpenRouter({ apiKey: apiKey });
  const prompt = `
You are an expert personal email assistant. 
Classify this email into ONE category:

Use "SURE_DELETE" when it falls in these categories well
and "UN_SURE_DELETE" when it partially matches: 
  - Promotions
  - here is your digit code
  - marketing
  - expired coupons
  - social alerts
  - newsletter updates
  - redemptions
  - routine account maintence
  - two factor passcodes
  - bank statements
  - security alerts
  - any package status updates
  - cloud payments
  - donations
  - payment plans
  - parking payments
  - cloud costs
  - gas purchases
  - mundane purchases
  - asking for feedback

"KEEP" when it is similar to these categories: 
  - appointments
  - etransfers
  - hotel and flight purchases
  - quotes
  - exporting data
  - backups

"RECEIPTS" when it is similar to these categories: 
  - unique purchases
  - reservations
  - real world item purchases from retailers
  - software keys 
  - purchases
  - financing
  - order confirmed
  - charges

Respond with only valid json, NO BACKTICKS. 
Return a list of json object with the fields \`action\`, and \`id\`.
In the \`action\` field is one of: SURE_DELETE, UN_SURE_DELETE, RECEIPTS, or KEEP.
And the id is the id you have evaluated

This is the json:

\`${JSON.stringify(data)}\``;

  try {
    const { text } = await generateText({
      // model: openrouter('anthropic/claude-haiku-5.5'),
      // model: openrouter('google/gemini-3.1-flash-lite'),
      model: openrouter('deepseek/deepseek-v4.1-flash'),

      prompt: prompt,
      maxRetries: 2,
      timeout: {
        totalMs: 305000,
      },
    });

    return text;
  } catch (err) {
    console.error('AI error:', err.message);
    return 'KEEP'; // Fallback to safe keeping if API fails
  }
}
