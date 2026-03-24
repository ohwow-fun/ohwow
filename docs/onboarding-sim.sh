#!/usr/bin/env bash
# Simulated ohwow onboarding flow for README GIF — six screens (~25s)
# Mirrors the real TUI onboarding: Splash → Model → Business → Founder → Agents → Ready
#
# All output uses echo (not printf format strings) to avoid escape collisions.
# Color variables hold real ANSI bytes via $'...' so echo passes them through.

set -e

# Colors — $'...' evaluates escapes at assignment, so these are real bytes
BOLD=$'\033[1m'
DIM=$'\033[2m'
RESET=$'\033[0m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
WHITE=$'\033[37m'
GRAY=$'\033[90m'

# Box drawing
H="─"
RND_TL="╭" RND_TR="╮" RND_BL="╰" RND_BR="╯" BOX_V="│"

W=80

slowprint() {
  local text="$1" delay="${2:-0.02}"
  local i
  for (( i=0; i<${#text}; i++ )); do
    printf '%s' "${text:$i:1}"
    sleep "$delay"
  done
  echo
}

# Repeat a character N times (pure string, no printf format)
repeat_char() {
  local ch="$1" n="$2" out=""
  local i
  for (( i=0; i<n; i++ )); do out+="$ch"; done
  printf '%s' "$out"
}

clear_screen() {
  printf '\033[2J\033[H'
}

# Render a rounded-corner box. Lines are pre-padded by the caller.
render_box() {
  local color="$1"
  shift
  local inner=$((W - 4))
  local rule
  rule=$(repeat_char "$H" "$inner")
  echo "  ${color}${RND_TL}${rule}${RND_TR}${RESET}"
  for line in "$@"; do
    echo "  ${color}${BOX_V}${RESET} ${line}"
  done
  echo "  ${color}${RND_BL}${rule}${RND_BR}${RESET}"
}

render_progress_bar() {
  local pct="$1" width=30
  local filled=$(( (pct * width) / 100 ))
  local empty=$(( width - filled ))
  local bar=""
  local i
  for (( i=0; i<filled; i++ )); do bar+="█"; done
  for (( i=0; i<empty; i++ )); do bar+="░"; done
  echo "[${bar}] ${pct}%"
}

# ═════════════════════════════════════════════════════════════════════════════
# SCENE 1: SPLASH (3s)
# ═════════════════════════════════════════════════════════════════════════════

sleep 0.3
clear_screen
echo ""
echo ""
echo "  ${BOLD}${CYAN}________    ___ ___  __      __________  __      __${RESET}"
echo "  ${BOLD}${CYAN}\\_____  \\  /   |   \\/  \\    /  \\_____  \\/  \\    /  \\${RESET}"
echo "  ${BOLD}${CYAN} /   |   \\/    ~    \\   \\/\\/   //   |   \\   \\/\\/   /${RESET}"
echo "  ${BOLD}${CYAN}/    |    \\    Y    /\\        //    |    \\        /${RESET}"
echo "  ${BOLD}${CYAN}\\_______  /\\___|_  /  \\__/\\  / \\_______  /\\__/\\  /${RESET}"
echo "  ${BOLD}${CYAN}        \\/       \\/        \\/          \\/      \\/${RESET}"
echo ""
echo "  ${BOLD}${WHITE}Your AI team, running on your machine.${RESET}"
echo ""
echo "  ${GRAY}No account needed. No cloud required.${RESET}"
echo ""
echo ""
echo "  ${GRAY}Press ${BOLD}${WHITE}Enter${RESET}${GRAY} to get started${RESET}"
echo "  ${DIM}${GRAY}Free forever for local use${RESET}"

sleep 3.0

# ═════════════════════════════════════════════════════════════════════════════
# SCENE 2: MODEL DETECTION + SELECTION (4s)
# ═════════════════════════════════════════════════════════════════════════════

clear_screen
echo ""
echo "  ${BOLD}${WHITE}Your First Model${RESET}"
echo ""
echo "  ${YELLOW}Detecting your hardware...${RESET}"

sleep 0.8

clear_screen
echo ""
echo "  ${BOLD}${WHITE}Your First Model${RESET}"
echo ""
echo "  ${GRAY}Apple M2 Pro, 16 GB RAM, Ollama running${RESET}"
echo ""

render_box "${CYAN}" \
  "${BOLD}${WHITE}Llama 3.2 3B${RESET}              ${CYAN}★ Best for your machine${RESET}                    ${CYAN}${BOX_V}${RESET}" \
  "${GRAY}Fast, capable, runs entirely on your hardware${RESET}                            ${CYAN}${BOX_V}${RESET}" \
  "                                                                            ${CYAN}${BOX_V}${RESET}" \
  "${GRAY}2.0 GB download · ~1 min · general, coding, analysis${RESET}                     ${CYAN}${BOX_V}${RESET}"

echo ""
echo "  ${CYAN}$(render_progress_bar 0)${RESET}"
echo "  ${GRAY}Starting download...${RESET}"

sleep 0.6

clear_screen
echo ""
echo "  ${BOLD}${WHITE}Downloading Llama 3.2 3B${RESET}"
echo "  ${GRAY}llama3.2:3b (2.0 GB)${RESET}"
echo ""
echo "  ${CYAN}$(render_progress_bar 45)${RESET}"
echo "  ${GRAY}Pulling layers... 924 MB / 2.0 GB${RESET}"

sleep 0.8

clear_screen
echo ""
echo "  ${BOLD}${WHITE}Downloading Llama 3.2 3B${RESET}"
echo "  ${GRAY}llama3.2:3b (2.0 GB)${RESET}"
echo ""
echo "  ${CYAN}$(render_progress_bar 100)${RESET}"
echo "  ${GREEN}✓ Ready to use${RESET}"

sleep 0.8

# ═════════════════════════════════════════════════════════════════════════════
# SCENE 3: BUSINESS INFO (4s)
# ═════════════════════════════════════════════════════════════════════════════

clear_screen
echo ""
echo "  ${BOLD}${WHITE}Tell us about your business${RESET}"
echo "  ${GRAY}This helps us recommend the right AI agents for you.${RESET}"
echo ""
echo "  ${CYAN}Business name${RESET}"
printf '  %s' "${CYAN}> ${RESET}"
slowprint "Sunrise Bakery" 0.05
echo ""

sleep 0.3

# Type selection
clear_screen
echo ""
echo "  ${BOLD}${WHITE}Tell us about your business${RESET}"
echo "  ${GRAY}This helps us recommend the right AI agents for you.${RESET}"
echo ""
echo "  ${GRAY}Business name${RESET}"
echo "    ${WHITE}Sunrise Bakery${RESET}"
echo ""
echo "  ${CYAN}Business type${RESET}"
echo "    ${GRAY}  SaaS Startup${RESET}"
echo "    ${GRAY}  Ecommerce${RESET}"
echo "    ${GRAY}  Agency${RESET}"
echo "    ${GRAY}  Content Creator${RESET}"
echo "  ${CYAN}❯ ${BOLD}${WHITE}Service Business${RESET}"
echo "    ${GRAY}  Consulting${RESET}"

sleep 0.6

# Description
clear_screen
echo ""
echo "  ${BOLD}${WHITE}Tell us about your business${RESET}"
echo "  ${GRAY}This helps us recommend the right AI agents for you.${RESET}"
echo ""
echo "  ${GRAY}Business name${RESET}"
echo "    ${WHITE}Sunrise Bakery${RESET}"
echo ""
echo "  ${GRAY}Business type${RESET}"
echo "    ${WHITE}Service Business${RESET}"
echo ""
echo "  ${CYAN}What does your business do? (one sentence)${RESET}"
printf '  %s' "${CYAN}> ${RESET}"
slowprint "We bake artisan bread and deliver to local restaurants" 0.03

sleep 0.5

# ═════════════════════════════════════════════════════════════════════════════
# SCENE 4: FOUNDER STAGE (2.5s)
# ═════════════════════════════════════════════════════════════════════════════

clear_screen
echo ""
echo "  ${BOLD}${WHITE}Where are you in your journey?${RESET}"
echo "  ${GRAY}This helps us prioritize which agents to recommend.${RESET}"
echo ""
echo "  ${CYAN}Your stage${RESET}"
echo "    ${GRAY}  Exploring ideas${RESET}"
echo "    ${GRAY}  Just starting${RESET}"
echo "    ${GRAY}  Pre-revenue${RESET}"
echo "  ${CYAN}❯ ${BOLD}${WHITE}Making money${RESET}"
echo ""
echo "  ${GRAY}What are you focused on right now?${RESET}"
printf '  %s' "${CYAN}> ${RESET}"
slowprint "Growing our delivery routes" 0.04

sleep 0.8

# ═════════════════════════════════════════════════════════════════════════════
# SCENE 5: AGENT SELECTION (6s)
# ═════════════════════════════════════════════════════════════════════════════

clear_screen
echo ""
echo "  ${BOLD}${WHITE}Choose your agents${RESET}"
echo "  ${GRAY}Toggle agents with Space. 3 selected.${RESET}"
echo ""
echo "    ${GREEN}[✓]${RESET} ${WHITE}Local SEO Manager${RESET}${GRAY} — Local Content Creator${RESET}"
echo ""
echo "    ${GREEN}[✓]${RESET} ${WHITE}Review Response Manager${RESET}${GRAY} — Online Reputation Handler${RESET}"
echo ""
echo "    ${GREEN}[✓]${RESET} ${WHITE}Quote Manager${RESET}${GRAY} — Service Quote Creator${RESET}"
echo ""
echo "  ${CYAN}❯ ${GRAY}[ ]${RESET} ${BOLD}${WHITE}Follow-Up Specialist${RESET}${GRAY} — Lead Nurturing${RESET}"
echo "          ${DIM}${GRAY}Sends follow-up emails to quote requests and inquiries${RESET}"
echo ""
echo "    ${GRAY}[ ]${RESET} ${GRAY}Inquiry Handler${RESET}${GRAY} — Initial Contact Responder${RESET}"
echo ""
echo "    ${GRAY}[ ]${RESET} ${GRAY}Field Dispatch${RESET}${GRAY} — Job Scheduling Coordinator${RESET}"
echo ""
echo "  ${GRAY}j/k: Navigate   Space: Toggle   Enter: Create 3 agents   Esc: Back${RESET}"

sleep 1.5

# Toggle Follow-Up Specialist on
clear_screen
echo ""
echo "  ${BOLD}${WHITE}Choose your agents${RESET}"
echo "  ${GRAY}Toggle agents with Space. 4 selected.${RESET}"
echo ""
echo "    ${GREEN}[✓]${RESET} ${WHITE}Local SEO Manager${RESET}${GRAY} — Local Content Creator${RESET}"
echo ""
echo "    ${GREEN}[✓]${RESET} ${WHITE}Review Response Manager${RESET}${GRAY} — Online Reputation Handler${RESET}"
echo ""
echo "    ${GREEN}[✓]${RESET} ${WHITE}Quote Manager${RESET}${GRAY} — Service Quote Creator${RESET}"
echo ""
echo "  ${CYAN}❯ ${GREEN}[✓]${RESET} ${BOLD}${WHITE}Follow-Up Specialist${RESET}${GRAY} — Lead Nurturing${RESET}"
echo "          ${DIM}${GRAY}Sends follow-up emails to quote requests and inquiries${RESET}"
echo ""
echo "    ${GRAY}[ ]${RESET} ${GRAY}Inquiry Handler${RESET}${GRAY} — Initial Contact Responder${RESET}"
echo ""
echo "    ${GRAY}[ ]${RESET} ${GRAY}Field Dispatch${RESET}${GRAY} — Job Scheduling Coordinator${RESET}"
echo ""
echo "  ${GRAY}j/k: Navigate   Space: Toggle   Enter: Create 4 agents   Esc: Back${RESET}"

sleep 2.5

# ═════════════════════════════════════════════════════════════════════════════
# SCENE 6: READY SCREEN (5s)
# ═════════════════════════════════════════════════════════════════════════════

clear_screen
echo ""
echo "  ${BOLD}${GREEN}You're all set.${RESET}"
echo ""

render_box "${GREEN}" \
  "${GRAY}Business: ${BOLD}${WHITE}Sunrise Bakery${RESET}                                                  ${GREEN}${BOX_V}${RESET}" \
  "${GRAY}Model:    ${WHITE}Llama 3.2 3B${RESET}                                                    ${GREEN}${BOX_V}${RESET}" \
  "${GRAY}Agents:   ${WHITE}4 agents ready to go${RESET}                                            ${GREEN}${BOX_V}${RESET}"

echo ""
echo "  ${GRAY}Press ${BOLD}${WHITE}Enter${RESET}${GRAY} to open the dashboard.${RESET}"

sleep 5.0
