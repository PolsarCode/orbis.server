const colors = {
  page: '#151613',
  card: '#252623',
  divider: '#42433c',
  text: '#f1ede3',
  muted: '#aca99e',
  faint: '#777970',
  accent: '#f07357',
  onAccent: '#211c18',
};

const display = `'Barlow Condensed','Arial Narrow',Arial,sans-serif`;
const sans = `Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export type EmailLayout = {
  title: string;
  preview: string;
  heading: string;
  body: string;
  button: { label: string; link: string };
  footer: string;
};

export function emailHtml({
  title,
  preview,
  heading,
  body,
  button,
  footer,
}: EmailLayout) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>:root{color-scheme:dark;supported-color-schemes:dark}body{margin:0;padding:0}</style>
</head>
<body style="margin:0;padding:0;background-color:${colors.page};">
<div style="display:none;max-height:0;overflow:hidden;">${preview}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${colors.page};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td style="padding:0 4px 20px;font-family:${display};font-size:36px;font-weight:700;line-height:1;color:${colors.accent};">o.</td></tr>
<tr><td style="background-color:${colors.card};border:1px solid ${colors.divider};border-radius:16px;padding:32px;">
<h1 style="margin:0 0 12px;font-family:${display};font-size:30px;font-weight:700;line-height:1.15;color:${colors.text};">${heading}</h1>
<p style="margin:0 0 24px;font-family:${sans};font-size:15px;line-height:1.6;color:${colors.muted};">${body}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:8px;background-color:${colors.accent};">
<a href="${button.link}" style="display:inline-block;padding:12px 22px;font-family:${sans};font-size:15px;font-weight:600;line-height:1.2;color:${colors.onAccent};text-decoration:none;border-radius:8px;">${button.label}</a>
</td></tr></table>
<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid ${colors.divider};font-family:${sans};font-size:13px;line-height:1.6;color:${colors.muted};">Button not working? Paste this link into your browser:<br><a href="${button.link}" style="color:${colors.accent};word-break:break-all;">${button.link}</a></p>
</td></tr>
<tr><td style="padding:20px 4px 0;font-family:${sans};font-size:12px;line-height:1.6;color:${colors.faint};">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
