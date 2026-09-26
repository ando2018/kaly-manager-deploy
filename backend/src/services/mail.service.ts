import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config';
import { ContactMessage } from '../data/contact-messages';

let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const { host, port, secure, user, pass } = config.smtp;
  transporter = host
    ? nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined })
    : null;
  return transporter;
}

export function isMailConfigured(): boolean {
  return !!config.smtp.host && !!config.notifyEmail;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/** Whether SMTP itself is set up (independent of NOTIFY_EMAIL) — enough to write to anyone. */
export function isSmtpConfigured(): boolean {
  return !!config.smtp.host;
}

/** Sends one e-mail; throws on SMTP failure (callers decide whether that matters). */
export async function sendMail(
  to: string,
  subject: string,
  text: string,
  replyTo?: string,
  attachments?: MailAttachment[],
): Promise<void> {
  const t = getTransporter();
  if (!t) throw new Error("SMTP n'est pas configuré (SMTP_HOST manquant).");
  await t.sendMail({ from: config.smtp.from ?? config.smtp.user, to, subject, text, replyTo, attachments });
}

/**
 * Tells the platform admin a contact message (or a token request, which goes through the same form)
 * just arrived. Best effort: never blocks or fails the request that created the message.
 */
export function notifyNewContactMessage(msg: ContactMessage): void {
  if (!isMailConfigured()) return;
  const isTokenRequest = /token/i.test(msg.message);
  const where = msg.etablissementName
    ? `${msg.etablissementName} (${msg.etablissementIdAttempt ?? '?'})`
    : msg.etablissementIdAttempt ?? 'non précisé';
  const subject = `[Kaly Manager] ${isTokenRequest ? 'Demande de token' : 'Nouveau message de contact'} — ${msg.name}`;
  const text = [
    `Nouveau message reçu le ${new Date(msg.createdAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}.`,
    '',
    `Nom : ${msg.name}`,
    `E-mail : ${msg.email}`,
    `Téléphone : ${msg.phone}`,
    `Établissement : ${where}`,
    '',
    'Message :',
    msg.message,
    '',
    '—',
    'Répondez directement à cet e-mail pour écrire à la personne. Le message est aussi visible dans /ap > Messages.',
  ].join('\n');
  sendMail(config.notifyEmail!, subject, text, msg.email).catch((err) =>
    console.error('Notification e-mail non envoyée :', err instanceof Error ? err.message : err),
  );
}
