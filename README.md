# Fumu!

> Translate selected text instantly.
> An AI translation app for everyone.

![License](https://img.shields.io/badge/license-MIT-green)

[Download](../../releases/latest) · [GitHub Issues](../../issues)

<div align="center">
  <img src="assets/hero.png" width="900" alt="Fumu! — Translation, made more natural. More you.">
  <p><a href="README.ja.md">日本語</a></p>
</div>

---

## Translate anywhere, quickly

In a browser, an editor, or a PDF. Select the text you want to understand and press `Ctrl+Shift+J`.
A small popup appears beside you and starts translating the words you selected.

With Fumu!, you no longer need tedious copy-pasting or moving to another window.

---

## Together with the nuance

Translation is not just rephrasing.

- **Main translation** — a natural translation that understands the context
- **Nuance** — an explanation of the translator's intent and tone
- **Alternative expressions** — 2–3 versions with a different feel

A little more convenient, a little more fun.

---

## Choose your AI

Fumu! uses only the providers and models you choose.

- ChatGPT (Free / Plus / Pro sign-in)
- OpenAI / Anthropic / Google Gemini
- Groq / OpenRouter / DeepInfra / Mistral AI
- Ollama / LM Studio / Ollama Cloud
- Any OpenAI-compatible local server

Enable multiple models and try another one when the first fails.

---

## Install

Download `Fumu-Setup-1.0.0-x64.exe` from the [latest release](../../releases/latest) and run it.
Because the current installer is not code-signed, Windows may display a security warning.

Opening Settings checks GitHub Releases for updates. Select Update and restart to download the installer in the app, verify its SHA-256, quit, install, and restart. Approve any Windows permission prompt. Updating a portable copy switches to the installed edition.

---

## Inspiration

Fumu! is inspired by [nani.now](https://nani.now/). It is an independent project and is not affiliated with nani.now.

---

## Development

### Requirements

- Windows 10 version 2004 or later, x64
- Node.js 24 or later
- npm 11 or later
- Visual Studio 2022 Build Tools when rebuilding the native addon

### Setup

```powershell
npm install
npm run dev
```
