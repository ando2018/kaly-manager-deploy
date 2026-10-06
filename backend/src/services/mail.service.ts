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

export interface PurchaseMailInfo {
  /** Application the subscription is for — Kaly Manager when absent. */
  appName?: string;
  etablissementName: string;
  etablissementId: string;
  planLabel: string;
  duration: string;
  price: number;
  tokenCode: string;
  purchasedAt: Date;
  accessUntil: Date;
  /** Direct link to the établissement's connection page, when the app's address is known. */
  link?: string;
}

/** Sends the établissement its token and the details of what was just bought. Throws on SMTP failure. */
export async function sendSubscriptionPurchaseMail(to: string, info: PurchaseMailInfo): Promise<void> {
  const when = (d: Date) => d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short' });
  const app = info.appName ?? 'Kaly Manager';
  const text = [
    'Bonjour,',
    '',
    `Merci pour votre achat : l'abonnement ${app} de « ${info.etablissementName} » est activé.`,
    '',
    '— Récapitulatif —',
    `Entreprise : ${info.etablissementName}`,
    `Identifiant : ${info.etablissementId}`,
    `Formule : ${info.planLabel} (${info.duration})`,
    `Prix : ${info.price.toFixed(2).replace('.', ',')} €`,
    `Date d'achat : ${when(info.purchasedAt)}`,
    `Accès valable jusqu'au : ${when(info.accessUntil)}`,
    '',
    `Token d'abonnement : ${info.tokenCode}`,
    "Il est déjà rattaché à votre identifiant : vous n'avez rien à saisir. Conservez ce message comme justificatif.",
    ...(info.link ? ['', `Se connecter : ${info.link}`] : []),
    '',
    `L'équipe ${app}`,
  ].join('\n');
  await sendMail(to, `${app} — abonnement « ${info.planLabel} » activé pour ${info.etablissementName}`, text);
}

/** Acknowledges a token request to whoever made it. */
export async function sendTokenRequestAckMail(
  to: string,
  info: { appName: string; holderLabel: string; planLabel: string; duration: string; price: number },
): Promise<void> {
  const text = [
    'Bonjour,',
    '',
    `Nous avons bien reçu votre demande d'abonnement ${info.appName} :`,
    '',
    `Entreprise : ${info.holderLabel}`,
    `Forfait : ${info.planLabel} (${info.duration})`,
    `Prix : ${info.price.toFixed(2).replace('.', ',')} €`,
    '',
    'Nous revenons vers vous très vite avec les modalités de règlement ; votre token vous sera ensuite envoyé par e-mail.',
    '',
    `L'équipe ${info.appName}`,
  ].join('\n');
  await sendMail(to, `${info.appName} — demande d'abonnement « ${info.planLabel} » reçue`, text);
}

/** The provisional PIN after a platform reset, to the établissement's e-mail (the Direction). */
export async function sendPinResetMail(
  to: string,
  info: { etablissementName: string; etablissementId: string; userName: string; pinCode: string; link?: string },
): Promise<void> {
  const text = [
    'Bonjour,',
    '',
    `Le code PIN du compte Direction « ${info.userName} » de « ${info.etablissementName} » a été réinitialisé.`,
    '',
    `Code PIN provisoire : ${info.pinCode}`,
    `Identifiant de l'établissement : ${info.etablissementId}`,
    '',
    "À la première connexion, Kaly Manager vous demandera de choisir un nouveau code PIN.",
    "L'ancien code ne fonctionne plus. Si vous n'êtes pas à l'origine de cette demande, contactez-nous.",
    ...(info.link ? ['', `Se connecter : ${info.link}`] : []),
    '',
    "L'équipe Kaly Manager",
  ].join('\n');
  await sendMail(to, `Kaly Manager — code PIN provisoire pour ${info.etablissementName}`, text);
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
