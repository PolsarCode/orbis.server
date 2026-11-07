import { Logger } from '@nestjs/common';

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10000;
const DEFAULT_FROM = 'Orbis <onboarding@resend.dev>';

const logger = new Logger('Email');

export type Email = { to: string; subject: string; html: string; text: string };

function mailbox(address: string) {
  const match = /^(.*)<([^>]+)>$/.exec(address.trim());
  if (!match) return { Email: address.trim() };
  const name = match[1].trim();
  return name ? { Name: name, Email: match[2] } : { Email: match[2] };
}

async function post(service: string, url: string, init: RequestInit) {
  const response = await fetch(url, {
    method: 'POST',
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `${service} refused the email with ${response.status}: ${await response.text()}`,
    );
  }
}

export async function sendEmail(email: Email) {
  const from = process.env.EMAIL_FROM || DEFAULT_FROM;
  const key = process.env.RESEND_API_KEY;
  const mailpit = process.env.MAILPIT_URL;

  if (key) {
    await post('Resend', RESEND_URL, {
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, ...email }),
    }).catch((error: Error) => {
      throw new Error(`${error.message} (sent from ${JSON.stringify(from)})`);
    });
    return;
  }

  if (mailpit) {
    await post('Mailpit', `${mailpit.replace(/\/+$/, '')}/api/v1/send`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        From: mailbox(from),
        To: [mailbox(email.to)],
        Subject: email.subject,
        Text: email.text,
        HTML: email.html,
      }),
    });
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    logger.error(`RESEND_API_KEY isn’t set, so “${email.subject}” wasn’t sent`);
  } else {
    logger.log(
      `Neither RESEND_API_KEY nor MAILPIT_URL is set, so here’s the email instead.\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}`,
    );
  }
}

export function sendInBackground(email: Email) {
  sendEmail(email).catch((error: Error) =>
    logger.error(`Couldn’t send “${email.subject}”: ${error.message}`),
  );
}
