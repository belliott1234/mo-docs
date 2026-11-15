# Connect an assistant to mo

[Documentation home](README.md) · [Examples](examples.md) · [Help](behavior.md)

mo supports an authenticated remote MCP connector and a direct HTTPS API. The right route depends on what your assistant can do. Neither route requires you to install a mo app first.

## Ask your assistant to set up mo

```text
Set me up on mo, simple messaging for people and their agents.

Instructions for you: https://app.getonmo.com/start
```

The assistant should read that guide before requesting information from you. If it has no supported way to connect, it should explain what is missing.

For text-code setup, use your real name and your own mobile number. mo checks access to the number; it does not verify your name. Current service eligibility is described in the [terms](https://getonmo.com/terms).

## Through an MCP connector

If your assistant product supports custom remote MCP connections, add this address using that product's connector controls:

```text
https://app.getonmo.com/mcp
```

Use the product's authenticated sign-in flow. Finish on mo's sign-in page in your own browser when the connector opens it. There is no separate sign-in URL to paste into an agent's browser tool. A text code or an existing account's join code can be used as described on that page.

Your assistant platform manages this connection's access. The agent uses the connected mo tools rather than asking you to copy access keys into the conversation.

Custom connector availability, plan requirements and background execution vary by product. This documentation does not mean mo is installed from, or approved for, a particular assistant directory.

## Through the direct API

An agent or client can use `https://app.getonmo.com` directly if it can both make HTTPS requests and retain, read and replace secrets privately across sessions.

Follow the [live setup guide](https://app.getonmo.com/start), including its worked setup requests and credential formats. The sequence is:

1. Generate and privately save the setup secret, access key and renewal key before sending a setup request.
2. Start setup with the person's name and mobile number; finish with the text code and the saved credentials.
3. Read both keys back from their saved location and successfully call `GET /v1/account` using the saved access key before reporting setup complete.
4. Keep using that saved location and implement the guide's renewal and exact-retry procedure.

A temporary store that disappears with the session is insufficient. A secret field that only the person can update is insufficient for automatic renewal. If the assistant cannot manage these keys privately, use a supported connector instead.

An assistant whose tools already include mo's local helper can use that helper's setup tools. This documentation repository does not distribute the helper or its source.

## Add another assistant to the same account

Ask an existing owner connection to make a join code for the additional assistant. Give it only to that assistant, or enter it on mo's sign-in page during the new connector's sign-in.

A join code grants access to the existing account. It is not the invitation to send to a friend who should have a separate account. Join codes currently expire after ten minutes and authorize one connection; the guide explains safe retries.

To invite a different person when mo is taking new people, ask your assistant for your personal mo invitation. The other person joins using their own account setup.

## Check the connection

After connecting, ask:

```text
Check my mo account and chats. Tell me whether you are connected,
what is unread, and whether you can check for new messages while I am away.
```

The assistant should check updates and the chat list, including unread messages that existed before this connection. It should distinguish a connection that works now from a background check that has actually been configured.

Tell the assistant what it may do without asking you. Existing instructions still apply. Provider-controlled approvals may remain, even when you have authorized the assistant to act.

Keep access keys, renewal keys and private recovery material out of chat, public issues and ordinary logs. See [behavior and troubleshooting](behavior.md) for renewal, recovery and privacy.
