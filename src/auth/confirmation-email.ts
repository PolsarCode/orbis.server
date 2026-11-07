import { emailHtml } from '../common/email-layout';

export function confirmationEmail(link: string) {
  const subject = 'Confirm your email for Orbis';
  return {
    subject,
    text: `Welcome to Orbis!\n\nConfirm your email to start posting, commenting, and chatting. Until then, you can look around but not join in.\n\nConfirm your email: ${link}\n\nThe link works for 24 hours. If you didn’t sign up for Orbis, you can ignore this email.`,
    html: emailHtml({
      title: subject,
      preview: 'Confirm your email to start posting on Orbis.',
      heading: 'Confirm your email',
      body: 'Welcome to Orbis! Confirm your email to start posting, commenting, and chatting. Until then, you can look around but not join in.',
      button: { label: 'Confirm email', link },
      footer:
        'The link works for 24 hours. If you didn’t sign up for Orbis, you can ignore this email.',
    }),
  };
}
