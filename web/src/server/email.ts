/**
 * Outgoing mail: password resets and email verification. Resend when
 * RESEND_API_KEY is set (one HTTP call, no SDK); in development without it,
 * the message goes to the server log so the link can still be clicked.
 */
import { EMAIL } from './env';
import { DEFAULT_BRAND } from '@/lib/brand';

export interface Mail {
  to: string;
  subject: string;
  /** Plain text. The HTML version is drawn from it, so the two never disagree. */
  text: string;
  action?: { label: string; url: string };
}

export async function sendMail(mail: Mail): Promise<void> {
  if (EMAIL.provider === 'log') {
    console.info(`\n[email] to ${mail.to}: ${mail.subject}\n${mail.text}${mail.action === undefined ? '' : `\n${mail.action.label}: ${mail.action.url}`}\n`);
    return;
  }
  if (EMAIL.provider === 'none') throw new Error('Email is not configured on this server.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${EMAIL.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: EMAIL.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.action === undefined ? mail.text : `${mail.text}\n\n${mail.action.label}: ${mail.action.url}`,
      html: renderHtml(mail),
    }),
  });
  if (!response.ok) throw new Error(`The email provider refused the message (${response.status}): ${(await response.text()).slice(0, 300)}`);
}

function renderHtml(mail: Mail): string {
  const paragraphs = mail.text
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button =
    mail.action === undefined
      ? ''
      : `<p style="margin:24px 0"><a href="${escapeHtml(mail.action.url)}" style="background:#6d28d9;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(mail.action.label)}</a></p><p style="margin:0 0 16px;color:#6b7280;font-size:13px;line-height:1.5">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(mail.action.url)}</span></p>`;
  return `<!doctype html><html><body style="margin:0;background:#f6f5fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b"><div style="max-width:520px;margin:0 auto;padding:32px 20px"><div style="background:#fff;border:1px solid #e7e5ef;border-radius:14px;padding:28px"><p style="margin:0 0 20px;font-weight:700;font-size:17px">${escapeHtml(DEFAULT_BRAND.name)}</p>${paragraphs}${button}</div><p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:16px">You are getting this because someone used this address on ${escapeHtml(DEFAULT_BRAND.name)}. If it was not you, ignore it.</p></div></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
