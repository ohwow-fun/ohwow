#!/usr/bin/env bash
# Simulated ohwow demo for README GIF — multi-screen desire engine (v3)
# Five scenes with real screen transitions: Dashboard → Chat → Agents → Chat → Dashboard

set -e

# Colors
BOLD="\033[1m"
DIM="\033[2m"
RESET="\033[0m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
MAGENTA="\033[35m"
BLUE="\033[34m"
WHITE="\033[37m"
GRAY="\033[90m"

# Box drawing
BOX_TL="┌" BOX_TR="┐" BOX_BL="└" BOX_BR="┘" BOX_H="─" BOX_V="│"
RND_TL="╭" RND_TR="╮" RND_BL="╰" RND_BR="╯"

# Terminal width for box drawing
W=84

slowprint() {
  local text="$1"
  local delay="${2:-0.02}"
  for (( i=0; i<${#text}; i++ )); do
    printf '%s' "${text:$i:1}"
    sleep "$delay"
  done
  echo
}

hline() {
  local char="${1:-$BOX_H}" len="${2:-$W}"
  printf '%0.s'"$char" $(seq 1 "$len")
}

render_header() {
  local top="${BOX_TL}$(hline "$BOX_H" $W)${BOX_TR}"
  local bot="${BOX_BL}$(hline "$BOX_H" $W)${BOX_BR}"
  local content=" OHWOW Workspace v0.2.0  ${BOX_V}  PID 48291  Port 7700  Up 2h 14m"
  local right="${GREEN}●${RESET}${CYAN} Local  ${GREEN}●${RESET}${CYAN} WhatsApp${RESET}  ${DIM}14:32${RESET}"
  printf "${CYAN}${top}${RESET}\n"
  printf "${CYAN}${BOX_V}${RESET}${BOLD}${WHITE}${content}${RESET}     ${right} ${CYAN}${BOX_V}${RESET}\n"
  printf "${CYAN}${bot}${RESET}\n"
}

render_keyhints() {
  local top="${BOX_TL}$(hline "$BOX_H" $W)${BOX_TR}"
  local bot="${BOX_BL}$(hline "$BOX_H" $W)${BOX_BR}"
  printf "${GRAY}${top}${RESET}\n"
  printf "${GRAY}${BOX_V}${RESET} ${BOLD}${YELLOW}1${RESET}${GRAY}:Dashboard  ${BOLD}${YELLOW}2${RESET}${GRAY}:Agents  ${BOLD}${YELLOW}3${RESET}${GRAY}:Tasks  ${BOLD}${YELLOW}4${RESET}${GRAY}:Contacts  ${BOLD}${YELLOW}5${RESET}${GRAY}:Approvals  ${BOLD}${YELLOW}6${RESET}${GRAY}:Activity  ${BOLD}${YELLOW}7${RESET}${GRAY}:Settings${RESET} ${GRAY}${BOX_V}${RESET}\n"
  printf "${GRAY}${bot}${RESET}\n"
}

render_metric_box() {
  local value="$1" label="$2" color="$3"
  printf "${color}${RND_TL}$(hline "$BOX_H" 14)${RND_TR}${RESET}"
}
render_metric_val() {
  local value="$1" color="$2"
  printf "${color}${BOX_V}${RESET}${BOLD}${color}%14s${RESET}${color}${BOX_V}${RESET}" "$value"
}
render_metric_lbl() {
  local label="$1" color="$2"
  printf "${color}${BOX_V}${RESET}${DIM}%14s${RESET}${color}${BOX_V}${RESET}" "$label"
}
render_metric_bot() {
  local color="$1"
  printf "${color}${RND_BL}$(hline "$BOX_H" 14)${RND_BR}${RESET}"
}

render_metrics() {
  # Args: v1 l1 c1  v2 l2 c2  v3 l3 c3  v4 l4 c4
  local v1="$1" l1="$2" c1="$3" v2="$4" l2="$5" c2="$6"
  local v3="$7" l3="$8" c3="$9" v4="${10}" l4="${11}" c4="${12}"
  printf "  "
  render_metric_box "$v1" "$l1" "$c1"
  printf " "
  render_metric_box "$v2" "$l2" "$c2"
  printf " "
  render_metric_box "$v3" "$l3" "$c3"
  printf " "
  render_metric_box "$v4" "$l4" "$c4"
  printf "\n  "
  render_metric_val "$v1" "$c1"
  printf " "
  render_metric_val "$v2" "$c2"
  printf " "
  render_metric_val "$v3" "$c3"
  printf " "
  render_metric_val "$v4" "$c4"
  printf "\n  "
  render_metric_lbl "$l1" "$c1"
  printf " "
  render_metric_lbl "$l2" "$c2"
  printf " "
  render_metric_lbl "$l3" "$c3"
  printf " "
  render_metric_lbl "$l4" "$c4"
  printf "\n  "
  render_metric_bot "$c1"
  printf " "
  render_metric_bot "$c2"
  printf " "
  render_metric_bot "$c3"
  printf " "
  render_metric_bot "$c4"
  printf "\n"
}

clear_screen() {
  printf "\033[2J\033[H"
  render_header
}

# ═══════════════════════════════════════════════════════════════════════════════
# SCENE 1: DASHBOARD "BEFORE" — Command center at rest (3s)
# ═══════════════════════════════════════════════════════════════════════════════

sleep 0.3
render_header
echo ""

render_metrics "4" "Agents" "$CYAN" "0" "Tasks" "$GREEN" "0" "Tokens" "$YELLOW" "\$0.00" "Cost" "$MAGENTA"

echo ""
printf "  ${BOLD}${WHITE}LOCAL MODELS${RESET}\n"
printf "  ${GREEN}◉${RESET} llama3.2:3b          ${DIM}loaded (gpu)${RESET}        ${DIM}0 reqs       0 tokens${RESET}\n"
printf "  ${GRAY}●${RESET} nomic-embed-text     ${DIM}available${RESET}\n"
echo ""
printf "  ${BOLD}${WHITE}AGENTS${RESET}\n"
printf "  ${GREEN}●${RESET} Outreach Manager     ${DIM}idle           0 tasks   \$0.00${RESET}\n"
printf "  ${GREEN}●${RESET} Lead Researcher      ${DIM}idle           0 tasks   \$0.00${RESET}\n"
printf "  ${GREEN}●${RESET} WhatsApp Sender      ${DIM}idle           0 tasks   \$0.00${RESET}\n"
printf "  ${GREEN}●${RESET} Scheduler            ${DIM}idle           0 tasks   \$0.00${RESET}\n"
echo ""
printf "  ${BOLD}${WHITE}RECENT TASKS${RESET}\n"
printf "  ${DIM}  No tasks yet.${RESET}\n"
echo ""

render_keyhints

sleep 3.0

# ═══════════════════════════════════════════════════════════════════════════════
# SCENE 2: CHAT — 3 rapid exchanges (12s)
# ═══════════════════════════════════════════════════════════════════════════════

clear_screen
echo ""

# Exchange 1 — The Hook (4s)
printf "  ${BOLD}${CYAN}you${RESET}  ${DIM}just now${RESET}\n"
slowprint "  Find everyone who signed up this week and hasn't been contacted" 0.035
echo ""
sleep 0.8

printf "  ${BOLD}${MAGENTA}ohwow${RESET}  ${DIM}just now${RESET}\n"
sleep 0.3
printf "  ${GREEN}●${RESET} ${DIM}query_contacts(signed_up_after: Monday, outreach: none)${RESET}\n"
sleep 0.25
echo ""
printf "  Found ${BOLD}7 contacts${RESET} added since Monday with no outreach:\n"
sleep 0.15
printf "    Sarah Chen ${DIM}(SaaS, \$12K pipeline)${RESET} — signed up 3 days ago\n"
sleep 0.12
printf "    Marcus Webb ${DIM}(Agency, \$8K pipeline)${RESET} — signed up 2 days ago\n"
sleep 0.12
printf "    ${DIM}... and 5 more${RESET}\n"
echo ""

sleep 1.0

# Exchange 2 — The Power (4s)
printf "  ${BOLD}${CYAN}you${RESET}  ${DIM}just now${RESET}\n"
slowprint "  Draft a personal follow-up for each and send via WhatsApp" 0.03
echo ""
sleep 0.6

printf "  ${BOLD}${MAGENTA}ohwow${RESET}  ${DIM}just now${RESET}\n"
sleep 0.25
printf "  ${GREEN}●${RESET} ${DIM}draft_messages(7 contacts, personalized by industry)${RESET}\n"
sleep 0.2
printf "  ${GREEN}●${RESET} ${DIM}send_whatsapp(7 messages)${RESET}\n"
sleep 0.25
echo ""
printf "  Sent 7 personalized WhatsApp messages.\n"
sleep 0.15
printf "    ${DIM}Preview: \"Hey Sarah, saw you signed up earlier this week...\"${RESET}\n"
echo ""

sleep 1.0

# Exchange 3 — The Mesh (4s)
printf "  ${BOLD}${CYAN}you${RESET}  ${DIM}just now${RESET}\n"
slowprint "  Research each company. Use the office Mac if this one's busy" 0.03
echo ""
sleep 0.6

printf "  ${BOLD}${MAGENTA}ohwow${RESET}  ${DIM}just now${RESET}\n"
sleep 0.25
printf "  ${GREEN}●${RESET} ${DIM}route_to_peer(office-imac, reason: CPU at 92%%)${RESET}\n"
sleep 0.2
printf "  ${GREEN}●${RESET} ${DIM}browse_websites(7 companies)${RESET}\n"
sleep 0.2
printf "  ${GREEN}●${RESET} ${DIM}enrich_contacts(7 profiles)${RESET}\n"
sleep 0.25
echo ""
printf "  All 7 contacts enriched with company data.\n"
sleep 0.15
printf "    Sarah's company: B2B analytics, 50 employees, Series A\n"
sleep 0.12
printf "    ${DIM}Ran on office-imac via mesh. Local Ollama, \$0.00.${RESET}\n"
echo ""

render_keyhints

sleep 1.0

# ═══════════════════════════════════════════════════════════════════════════════
# SCENE 3: AGENTS VIEW — Visual proof (3s)
# ═══════════════════════════════════════════════════════════════════════════════

clear_screen
echo ""

printf "  ${BOLD}${WHITE}AGENTS (4)${RESET}\n"
echo ""
printf "  ${YELLOW}◉${RESET} Outreach Manager      ${DIM}messaging${RESET}          ${YELLOW}working${RESET}        7 tasks   \$0.01\n"
printf "  ${YELLOW}◉${RESET} Lead Researcher        ${DIM}research${RESET}           ${YELLOW}working${RESET}        7 tasks   \$0.00\n"
printf "  ${GREEN}●${RESET} WhatsApp Sender        ${DIM}delivery${RESET}           ${GREEN}idle${RESET}           7 tasks   \$0.00\n"
printf "  ${GREEN}●${RESET} Scheduler              ${DIM}scheduling${RESET}         ${GREEN}idle${RESET}           0 tasks   \$0.00\n"
echo ""

render_keyhints

sleep 3.0

# ═══════════════════════════════════════════════════════════════════════════════
# SCENE 4: CHAT — Schedule + Payoff (5s)
# ═══════════════════════════════════════════════════════════════════════════════

clear_screen
echo ""

printf "  ${BOLD}${CYAN}you${RESET}  ${DIM}just now${RESET}\n"
slowprint "  Schedule all of this every Monday at 9am" 0.03
echo ""
sleep 0.5

printf "  ${BOLD}${MAGENTA}ohwow${RESET}  ${DIM}just now${RESET}\n"
sleep 0.25
printf "  ${GREEN}●${RESET} ${DIM}create_schedule(weekly, Monday 9:00 AM)${RESET}\n"
sleep 0.2
printf "  ${GREEN}●${RESET} ${DIM}create_automation(find → research → personalize → send)${RESET}\n"
sleep 0.25
echo ""
printf "  Scheduled: ${BOLD}Weekly lead pipeline${RESET}, Monday 9:00 AM.\n"
sleep 0.15
printf "    Find new signups, research, personalize, send via WhatsApp.\n"
sleep 0.12
printf "    ${DIM}Runs across your devices. No cloud required.${RESET}\n"
echo ""

render_keyhints

sleep 2.5

# ═══════════════════════════════════════════════════════════════════════════════
# SCENE 5: DASHBOARD "AFTER" — Transformation (3s)
# ═══════════════════════════════════════════════════════════════════════════════

clear_screen
echo ""

render_metrics "4" "Agents" "$CYAN" "21" "Tasks" "$GREEN" "4.2K" "Tokens" "$YELLOW" "\$0.03" "Cost" "$MAGENTA"

echo ""
printf "  ${BOLD}${WHITE}LOCAL MODELS${RESET}\n"
printf "  ${GREEN}◉${RESET} llama3.2:3b          ${DIM}loaded (gpu)${RESET}       18 reqs   3.8K tokens   1.2s avg\n"
printf "  ${GRAY}●${RESET} nomic-embed-text     ${DIM}available${RESET}\n"
echo ""
printf "  ${BOLD}${WHITE}AGENTS${RESET}\n"
printf "  ${YELLOW}◉${RESET} Outreach Manager     ${YELLOW}working${RESET}        7 tasks   \$0.01\n"
printf "  ${YELLOW}◉${RESET} Lead Researcher      ${YELLOW}working${RESET}        7 tasks   \$0.00\n"
printf "  ${GREEN}●${RESET} WhatsApp Sender      ${DIM}idle${RESET}           7 tasks   \$0.00\n"
printf "  ${GREEN}●${RESET} Scheduler            ${DIM}idle${RESET}           1 tasks   \$0.00\n"
echo ""
printf "  ${BOLD}${WHITE}RECENT TASKS${RESET}\n"
printf "  ${GREEN}✓${RESET} Send WhatsApp to Sarah Chen                     ${DIM}just now${RESET}\n"
printf "  ${GREEN}✓${RESET} Research: B2B Analytics Co                      ${DIM}just now${RESET}\n"
printf "  ${GREEN}✓${RESET} Enrich contact: Marcus Webb                     ${DIM}1m ago${RESET}\n"
printf "  ${GREEN}✓${RESET} Draft outreach: Sarah Chen                      ${DIM}1m ago${RESET}\n"
printf "  ${YELLOW}◉${RESET} Schedule weekly pipeline                        ${DIM}just now${RESET}\n"
echo ""

render_keyhints

sleep 3.0
