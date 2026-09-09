# Free Providers - Zero Cost Fallback

Emergency backup when everything else is quota-limited. Code 24/7 with zero cost!

---

## Overview

Free tier providers are your **fallback** when subscription and cheap quota exhausted:

- 🆓 **iFlow** - 8 models FREE (Kimi K2, Qwen3, GLM 4.7, MiniMax M2...)
- 🆓 **Qwen** - 3 models FREE (Qwen3 Coder Plus/Flash, Vision)
- 🆓 **Kiro** - 2 models FREE (Claude Sonnet 4.5, Haiku 4.5)
- 🆓 **Cline Free** - 17 models FREE (Nemotron 3 Ultra, Nex N2.5, Inkling, Laguna, Gemma 4...)

**Strategy:** Use as emergency backup. Unlimited usage, zero cost forever!

---

## iFlow (8 FREE Models)

### Pricing

| Plan | Monthly Cost | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | 8 models | Unlimited |

**Best Value:** Most models in free tier! Kimi K2, Qwen3, GLM, MiniMax, DeepSeek.

### Setup

**Step 1: Connect via Dashboard**

```bash
9router
# Dashboard → Providers → Connect iFlow
```

**Step 2: iFlow OAuth Login**

- Click "Connect iFlow"
- Browser opens → iFlow login page
- Create account or login
- Grant permissions
- Auto token refresh enabled

**Step 3: Use in CLI**

```
Model: if/kimi-k2-thinking
       if/kimi-k2
       if/qwen3-coder-plus
       if/glm-4.7
       if/minimax-m2
       if/deepseek-r1
       if/deepseek-v3.2-chat
       if/deepseek-v3.2-reasoner
```

### Available Models

| Model ID | Description | Best For |
|----------|-------------|----------|
| `if/kimi-k2-thinking` | Kimi K2 Thinking | Complex reasoning |
| `if/kimi-k2` | Kimi K2 | General coding |
| `if/qwen3-coder-plus` | Qwen3 Coder Plus | Code generation |
| `if/glm-4.7` | GLM 4.7 | Chinese + English |
| `if/minimax-m2` | MiniMax M2 | Long context |
| `if/deepseek-r1` | DeepSeek R1 | Reasoning tasks |
| `if/deepseek-v3.2-chat` | DeepSeek V3.2 Chat | Conversational |
| `if/deepseek-v3.2-reasoner` | DeepSeek V3.2 Reasoner | Complex logic |

### Pro Tips

- **8 models FREE** - Most variety in free tier
- **Unlimited usage** - No quota limits
- **Kimi K2 Thinking** - Best for complex reasoning
- **DeepSeek R1** - Strong reasoning capabilities

---

## Qwen (3 FREE Models)

### Pricing

| Plan | Monthly Cost | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | 3 models | Unlimited |

### Setup

**Step 1: Connect via Dashboard**

```bash
9router
# Dashboard → Providers → Connect Qwen
```

**Step 2: Device Code Authorization**

- Click "Connect Qwen"
- Dashboard shows device code
- Visit authorization URL
- Enter device code
- Login to Qwen account
- Auto token refresh enabled

**Step 3: Use in CLI**

```
Model: qw/qwen3-coder-plus
       qw/qwen3-coder-flash
       qw/vision-model
```

### Available Models

| Model ID | Description | Best For |
|----------|-------------|----------|
| `qw/qwen3-coder-plus` | Qwen3 Coder Plus | Advanced coding |
| `qw/qwen3-coder-flash` | Qwen3 Coder Flash | Fast responses |
| `qw/vision-model` | Qwen3 Vision | Image analysis |

### Pro Tips

- **Qwen3 Coder Plus** - Strong coding capabilities
- **Qwen3 Coder Flash** - Fast for quick tasks
- **Vision model** - FREE image analysis
- **Unlimited usage** - No quota limits

---

## Kiro (Claude FREE)

### Pricing

| Plan | Monthly Cost | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | Claude Sonnet 4.5, Haiku 4.5 | Unlimited |

**Best Value:** FREE Claude! Same quality as paid Claude Code.

### Setup

**Step 1: Connect via Dashboard**

```bash
9router
# Dashboard → Providers → Connect Kiro
```

**Step 2: AWS Builder ID or OAuth**

- Click "Connect Kiro"
- Choose login method:
  - AWS Builder ID (recommended)
  - Google account
  - GitHub account
- Grant permissions
- Auto token refresh enabled

**Step 3: Use in CLI**

```
Model: kr/claude-sonnet-4.5
       kr/claude-haiku-4.5
```

### Available Models

| Model ID | Description | Best For |
|----------|-------------|----------|
| `kr/claude-sonnet-4.5` | Claude Sonnet 4.5 | Balanced quality/speed |
| `kr/claude-haiku-4.5` | Claude Haiku 4.5 | Fast responses |

### Pro Tips

- **FREE Claude** - Same quality as paid tier
- **AWS Builder ID** - Easy setup with AWS account
- **Unlimited usage** - No quota limits
- **Best quality** - Claude 4.5 for free!

---

## Cline Free (17 FREE Models)

Cline's zero-cost model pool, reached through your Cline account. Same endpoint and
OAuth login as the paid `cline` / `clinepass` providers, but scoped to models that
cost nothing.

### Pricing

| Plan | Monthly Cost | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | 17 models (live list) | Rate-limited by Cline |

**Note:** Cline controls this list and its limits, and both change without notice.
9Router discovers the current set from Cline's own catalog at runtime; the bundled
list is only the fallback for when that lookup fails.

### Setup

**Step 1: Connect via Dashboard**

```bash
9router
# Dashboard → Providers → Connect Cline Free
```

**Step 2: Cline OAuth Login**

- Click "Connect Cline Free"
- Browser opens → Cline login page (app.cline.bot)
- Create account or login
- Auto token refresh enabled

An API key works too (Providers → Cline Free → Add API Key). A Cline account can be
connected to `cline`, `clinepass` and `cline-free` at the same time — each gets its
own connection, quota tracking and combo slot, so free traffic never mixes with paid.

**Step 3: Use in CLI**

```
Model: clf/nvidia/nemotron-3-ultra-550b-a55b:free
       clf/nex-agi/nex-n2.5-pro:free
       clf/thinkingmachines/inkling:free
```

### Available Models

Live list — run `/v1/models` (or open the provider page) to see what your account
currently has. The bundled fallback covers:

| Model ID | Description | Best For |
|----------|-------------|----------|
| `clf/nvidia/nemotron-3-ultra-550b-a55b:free` | Nemotron 3 Ultra 550B | Highest quality |
| `clf/nvidia/nemotron-3-super-120b-a12b:free` | Nemotron 3 Super 120B | Balanced |
| `clf/nex-agi/nex-n2.5-pro:free` | Nex N2.5 Pro | General coding |
| `clf/nex-agi/nex-n2.5-mini:free` | Nex N2.5 Mini | Fast responses |
| `clf/thinkingmachines/inkling:free` | Inkling | General chat |
| `clf/poolside/laguna-s-2.1:free` | Laguna S 2.1 | Coding |
| `clf/cohere/north-mini-code:free` | North Mini Code | Coding |
| `clf/google/gemma-4-31b-it:free` | Gemma 4 31B | Lightweight tasks |

Plus Ling 3.0 Flash, Nemotron 3.5 Lightning, Nemotron 3 Nano Omni Reasoning,
Gemma 4 26B, Dots 3 Note Preview and LFM 2.5.

### Pro Tips

- **Same account as ClinePass** - one Cline login covers paid and free
- **Fallback tier** - put `clf/*` last in a combo, not first; the limits are tight
- **List rotates** - Cline adds and removes free models often, so prefer live discovery over hardcoding
- **`:free` suffix is load-bearing** - it is what marks the model zero-cost upstream; don't strip it

---

## Feature Comparison

| Provider | Models | Best Model | Setup | Quota |
|----------|--------|------------|-------|-------|
| **iFlow** | 8 | Kimi K2 Thinking | OAuth | Unlimited |
| **Qwen** | 3 | Qwen3 Coder Plus | Device Code | Unlimited |
| **Kiro** | 2 | Claude Sonnet 4.5 | AWS Builder ID | Unlimited |
| **Cline Free** | 17 | Nemotron 3 Ultra 550B | OAuth / API key | Rate-limited |

**Winner:** iFlow for variety, Kiro for quality!

---

## Usage Example

### Cursor IDE Setup

```
Settings → Models → Advanced:
  OpenAI API Base URL: http://localhost:20128/v1
  OpenAI API Key: [from 9router dashboard]
  Model: if/kimi-k2-thinking
```

### Create Combo (Recommended)

```
Dashboard → Combos → Create New

Name: free-combo
Models:
  1. if/kimi-k2-thinking (iFlow primary)
  2. qw/qwen3-coder-plus (Qwen backup)
  3. kr/claude-sonnet-4.5 (Kiro quality)

Use in CLI: free-combo
```

**Result:** Zero cost, maximum uptime!

---

## Full Fallback Strategy

### Complete 3-Tier Combo

```
Dashboard → Combos → Create New

Name: complete-fallback
Models:
  1. gc/gemini-3-flash-preview (FREE subscription)
  2. cc/claude-opus-4-5 (Paid subscription)
  3. glm/glm-4.7 (Cheap backup, $0.6/1M)
  4. minimax/MiniMax-M2.1 (Cheapest, $0.2/1M)
  5. if/kimi-k2-thinking (FREE fallback)
  6. kr/claude-sonnet-4.5 (FREE quality)

Use in CLI: complete-fallback
```

**Result:**
- Tier 1: FREE subscription (Gemini CLI)
- Tier 2: Paid subscription (Claude Code)
- Tier 3: Cheap backup (GLM, MiniMax)
- Tier 4: FREE fallback (iFlow, Kiro)

**Never stop coding!**

---

## Best Practices

### 1. Use as Emergency Backup

```
Priority:
1. Subscription tier (maximize paid quota)
2. Cheap tier (pennies per 1M tokens)
3. FREE tier (unlimited, zero cost)

Only use free tier when:
- Subscription quota exhausted
- Budget limit reached
- Testing/non-critical tasks
```

### 2. Choose Right Model

```
Complex reasoning: if/kimi-k2-thinking
Fast coding: qw/qwen3-coder-flash
Best quality: kr/claude-sonnet-4.5
Long context: if/minimax-m2
Vision tasks: qw/vision-model
```

### 3. Create Free-Only Combo

```
For zero-cost coding:

Name: zero-cost
Models:
  1. kr/claude-sonnet-4.5 (Best quality)
  2. if/kimi-k2-thinking (Complex tasks)
  3. qw/qwen3-coder-plus (Fast coding)

Cost: $0 forever!
```

### 4. Test Before Production

```
Use free tier to:
- Test prompts
- Prototype features
- Learn new frameworks
- Non-critical tasks

Save paid quota for:
- Production code
- Complex refactoring
- Critical features
```

---

## Real-World Examples

### Example 1: Student/Learner (Zero Budget)

```
Setup:
1. kr/claude-sonnet-4.5 (Best quality)
2. if/kimi-k2-thinking (Complex reasoning)
3. qw/qwen3-coder-plus (Fast coding)

Monthly cost: $0
Usage: Unlimited

Perfect for:
- Learning to code
- Personal projects
- Homework/assignments
```

### Example 2: Freelancer (Budget-Conscious)

```
Setup:
1. gc/gemini-3-flash-preview (FREE 180K/month)
2. glm/glm-4.7 (Cheap backup, $0.6/1M)
3. if/kimi-k2-thinking (FREE fallback)

Monthly cost: $5-10
Usage: 100M+ tokens

Perfect for:
- Client projects (paid tier)
- Testing (free tier)
- Emergency backup
```

### Example 3: Heavy User (Maximize Everything)

```
Setup:
1. gc/gemini-3-flash-preview (FREE 180K/month)
2. cc/claude-opus-4-5 (Subscription $20-100)
3. cx/gpt-5.2-codex (Subscription $20-200)
4. glm/glm-4.7 (Cheap $0.6/1M)
5. minimax/MiniMax-M2.1 (Cheapest $0.2/1M)
6. if/kimi-k2-thinking (FREE unlimited)
7. kr/claude-sonnet-4.5 (FREE quality)

Monthly cost: $40-320 (subscriptions) + $10-20 (cheap tier)
Usage: 500M+ tokens

Perfect for:
- Professional development
- Team projects
- 24/7 coding
```

---

## Cost Comparison

### Scenario: 100M tokens/month

**Option 1: ChatGPT API Only**
```
100M × $20/1M = $2,000/month
```

**Option 2: 9Router Free Tier Only**
```
100M via free tier = $0/month
Savings: $2,000/month (100%)
```

**Option 3: 9Router Complete Strategy**
```
60M via Gemini CLI (FREE): $0
30M via Claude Code (subscription): $0 extra
8M via GLM (cheap): $4.80
2M via iFlow (FREE): $0
Total: $4.80/month + subscriptions you already have
Savings: $1,995/month (99.76%)
```

---

## Troubleshooting

### "OAuth failed"

**Solution:**
- Check internet connection
- Try different browser
- Clear browser cache
- Reconnect in dashboard

### "Model not available"

**Solution:**
- Check provider connected in dashboard
- Verify OAuth token valid
- Reconnect provider if needed

### "Slow responses"

**Solution:**
- Free tier may have lower priority
- Use during off-peak hours
- Switch to different free provider
- Upgrade to cheap tier for speed

---

## Limitations

### Free Tier Considerations

- **Speed** - May be slower than paid tiers
- **Priority** - Lower priority during peak hours
- **Rate limits** - Possible rate limiting (but unlimited quota)
- **Availability** - May have occasional downtime

**Solution:** Use 3-tier fallback strategy for reliability!

---

## Next Steps

- **Setup subscriptions:** [Subscription Providers](./subscription.md)
- **Add cheap backup:** [Cheap Providers](./cheap.md)
- **Create combos:** Dashboard → Combos → Create New
- **Start coding:** Use `complete-fallback` combo for maximum reliability
