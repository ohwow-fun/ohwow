-- Seed operational pillars (SQLite version)
-- Same data as cloud migration 342 but with SQLite-compatible syntax

INSERT OR REPLACE INTO agent_workforce_operational_pillars (id, slug, name, description, category, icon, business_types, min_stage, max_stage, priority_by_stage, kpis, setup_steps, estimated_setup_hours) VALUES

-- ACQUISITION
(lower(hex(randomblob(16))), 'content_pipeline', 'Content Pipeline',
 'Systematic content creation and distribution. Blog posts, social media, newsletters, videos. Builds organic discovery and establishes authority in your space.',
 'acquisition', 'pencil-line', '[]', 0, 9,
 '{"0":"important","1":"critical","2":"critical","3":"important","4":"important","5":"recommended","6":"recommended","7":"recommended","8":"critical","9":"recommended"}',
 '[{"name":"Posts published per week","target":2,"unit":"count"},{"name":"Organic traffic growth","target":10,"unit":"percent_monthly"},{"name":"Email subscribers","target":null,"unit":"count"}]',
 '[{"order":1,"title":"Audit existing content and brand voice","description":"Review what content exists, identify gaps, establish tone and style.","agent_role":"Content Strategist"},{"order":2,"title":"Build content calendar","description":"Plan 4 weeks of content across channels, aligned with business goals.","agent_role":"Content Strategist"},{"order":3,"title":"Draft first batch of content","description":"Create 4-6 pieces of content ready for review.","agent_role":"Content Creator"},{"order":4,"title":"Set up distribution channels","description":"Configure social media scheduling, newsletter tool, and cross-posting.","agent_role":"Social Media Manager"},{"order":5,"title":"Launch and measure","description":"Publish first batch, set up analytics tracking, establish baseline metrics.","agent_role":"Content Strategist"}]',
 3),

(lower(hex(randomblob(16))), 'outbound_outreach', 'Outbound Outreach',
 'Proactive outreach to potential customers. Cold email, DMs, partnerships, community engagement. Direct path to first customers and rapid feedback.',
 'acquisition', 'send', '[]', 0, 6,
 '{"0":"critical","1":"critical","2":"important","3":"recommended","4":"recommended","5":"recommended","6":"nice_to_have"}',
 '[{"name":"Outreach messages sent per week","target":50,"unit":"count"},{"name":"Reply rate","target":15,"unit":"percent"},{"name":"Conversations started","target":10,"unit":"count_weekly"}]',
 '[{"order":1,"title":"Define ideal customer profile","description":"Who exactly are you reaching out to? What pain do they have?","agent_role":"Sales Strategist"},{"order":2,"title":"Build prospect list","description":"Research and compile list of 200+ prospects from relevant communities, directories, and social platforms.","agent_role":"Lead Researcher"},{"order":3,"title":"Craft outreach sequences","description":"Write personalized message templates for 3 different angles. Test which resonates.","agent_role":"Outreach Specialist"},{"order":4,"title":"Launch first campaign","description":"Send first batch of 50 messages. Track replies, iterate on messaging.","agent_role":"Outreach Specialist"}]',
 2),

(lower(hex(randomblob(16))), 'community_building', 'Community Building',
 'Build and nurture a community around your product or niche. Discord, forum, social groups. Creates organic word-of-mouth and deep customer relationships.',
 'acquisition', 'users', '[]', 1, 9,
 '{"1":"recommended","2":"important","3":"important","4":"important","5":"critical","6":"important","7":"important","8":"critical","9":"important"}',
 '[{"name":"Active community members","target":null,"unit":"count"},{"name":"Weekly engagement rate","target":20,"unit":"percent"},{"name":"Community-sourced leads","target":null,"unit":"count_monthly"}]',
 '[{"order":1,"title":"Choose platform and structure","description":"Discord, GitHub Discussions, or forum. Define channels/categories for your audience.","agent_role":"Community Manager"},{"order":2,"title":"Seed with initial content","description":"Create 10+ discussion starters, resources, and guides.","agent_role":"Community Manager"},{"order":3,"title":"Invite first members","description":"Personal invites to existing users, supporters, and relevant contacts.","agent_role":"Outreach Specialist"},{"order":4,"title":"Establish engagement rhythm","description":"Weekly discussions, AMAs, showcases. Build habits.","agent_role":"Community Manager"}]',
 4),

(lower(hex(randomblob(16))), 'paid_acquisition', 'Paid Acquisition',
 'Paid advertising and sponsorships. Google Ads, social ads, newsletter sponsorships, influencer partnerships. Scalable customer acquisition with measurable ROI.',
 'acquisition', 'currency-dollar', '["saas_startup","ecommerce","b2b_enterprise_saas","education_edtech"]', 2, 9,
 '{"2":"recommended","3":"important","4":"critical","5":"critical","6":"important","7":"important","8":"important","9":"recommended"}',
 '[{"name":"Customer acquisition cost","target":null,"unit":"dollars"},{"name":"Return on ad spend","target":3,"unit":"ratio"},{"name":"Paid leads per week","target":null,"unit":"count"}]',
 '[{"order":1,"title":"Define unit economics","description":"Know your LTV, target CAC, and breakeven timeline before spending.","agent_role":"Financial Analyst"},{"order":2,"title":"Choose initial channel","description":"Pick ONE paid channel based on where your customers are. Start small.","agent_role":"Ad Strategist"},{"order":3,"title":"Create ad assets","description":"Write copy, design creatives, build landing pages for first campaign.","agent_role":"Ad Copywriter"},{"order":4,"title":"Launch and iterate","description":"Start with $20-50/day budget. Measure, optimize, scale what works.","agent_role":"Ad Strategist"}]',
 2),

(lower(hex(randomblob(16))), 'partnership_channel', 'Partnerships and Referrals',
 'Structured partnerships, affiliate programs, and referral systems. Leverage other people''s audiences and networks for scalable, trust-based growth.',
 'acquisition', 'handshake', '[]', 2, 9,
 '{"2":"nice_to_have","3":"recommended","4":"important","5":"critical","6":"critical","7":"important","8":"important","9":"important"}',
 '[{"name":"Active partners","target":null,"unit":"count"},{"name":"Partner-sourced revenue","target":null,"unit":"dollars_monthly"},{"name":"Referral conversion rate","target":20,"unit":"percent"}]',
 '[]', 3),

(lower(hex(randomblob(16))), 'seo_optimization', 'SEO and Organic Search',
 'Search engine optimization for long-term organic discovery. Keyword research, on-page optimization, link building.',
 'acquisition', 'search', '["saas_startup","ecommerce","agency","content_creator","service_business","consulting","education_edtech","b2b_enterprise_saas"]', 1, 9,
 '{"1":"recommended","2":"important","3":"important","4":"critical","5":"critical","6":"important","7":"recommended","8":"important","9":"recommended"}',
 '[{"name":"Organic search traffic","target":null,"unit":"visits_monthly"},{"name":"Keywords ranking top 10","target":null,"unit":"count"}]',
 '[]', 2),

-- RETENTION
(lower(hex(randomblob(16))), 'user_onboarding', 'User Onboarding',
 'Structured onboarding that gets new users to their first success moment. Emails, in-app guides, tutorials.',
 'retention', 'door-open', '["saas_startup","ecommerce","tech_company","education_edtech","b2b_enterprise_saas"]', 0, 9,
 '{"0":"important","1":"critical","2":"critical","3":"important","4":"important","5":"important"}',
 '[{"name":"Activation rate","target":40,"unit":"percent"},{"name":"Time to first value","target":null,"unit":"minutes"}]',
 '[]', 3),

(lower(hex(randomblob(16))), 'customer_feedback', 'Customer Feedback Loops',
 'Systematic collection and analysis of customer feedback. NPS, surveys, interviews, support tickets.',
 'retention', 'message-circle', '[]', 0, 9,
 '{"0":"critical","1":"critical","2":"important","3":"important","4":"important"}',
 '[{"name":"NPS score","target":40,"unit":"score"},{"name":"Feedback responses per month","target":null,"unit":"count"}]',
 '[]', 2),

(lower(hex(randomblob(16))), 'customer_support', 'Customer Support',
 'Responsive support system. Help docs, chatbot, ticket management, escalation paths.',
 'retention', 'life-buoy', '["saas_startup","ecommerce","tech_company","service_business","b2b_enterprise_saas","healthcare_wellness"]', 1, 9,
 '{"1":"recommended","2":"important","3":"critical","4":"critical","5":"critical"}',
 '[{"name":"First response time","target":4,"unit":"hours"},{"name":"Resolution rate","target":90,"unit":"percent"}]',
 '[]', 2),

(lower(hex(randomblob(16))), 'customer_success', 'Customer Success',
 'Proactive relationship management with existing customers. Check-ins, usage monitoring, expansion opportunities.',
 'retention', 'heart-handshake', '["saas_startup","agency","consulting","service_business","b2b_enterprise_saas"]', 3, 9,
 '{"3":"recommended","4":"important","5":"critical","6":"critical","7":"important"}',
 '[{"name":"Net revenue retention","target":110,"unit":"percent"},{"name":"Churn rate","target":5,"unit":"percent_monthly"}]',
 '[]', 3),

-- OPERATIONS
(lower(hex(randomblob(16))), 'process_documentation', 'Process Documentation (SOPs)',
 'Document how things work. Standard operating procedures for recurring tasks.',
 'operations', 'file-text', '[]', 3, 9,
 '{"3":"critical","4":"important","5":"important","6":"critical","7":"critical"}',
 '[{"name":"Documented processes","target":null,"unit":"count"}]',
 '[]', 4),

(lower(hex(randomblob(16))), 'reporting_analytics', 'Reporting and Analytics',
 'Know your numbers. Dashboards, weekly reports, KPI tracking.',
 'operations', 'chart-bar', '[]', 0, 9,
 '{"0":"recommended","1":"important","2":"critical","3":"critical","4":"critical"}',
 '[{"name":"Metrics tracked","target":null,"unit":"count"},{"name":"Report delivery consistency","target":100,"unit":"percent_weekly"}]',
 '[]', 2),

(lower(hex(randomblob(16))), 'automation_workflows', 'Workflow Automation',
 'Automate repetitive tasks. Scheduled jobs, triggered actions. Every manual step eliminated is time reclaimed forever.',
 'operations', 'workflow', '[]', 2, 9,
 '{"2":"recommended","3":"critical","4":"critical","5":"important","6":"critical"}',
 '[{"name":"Automated workflows running","target":null,"unit":"count"},{"name":"Hours saved per week","target":null,"unit":"hours"}]',
 '[]', 2),

-- FINANCE
(lower(hex(randomblob(16))), 'pricing_strategy', 'Pricing Strategy',
 'Intentional pricing that reflects value and supports growth.',
 'finance', 'tag', '[]', 1, 9,
 '{"1":"critical","2":"important","3":"important","4":"critical","5":"important","6":"critical"}',
 '[{"name":"Revenue per customer","target":null,"unit":"dollars"}]',
 '[]', 2),

(lower(hex(randomblob(16))), 'financial_tracking', 'Financial Tracking',
 'Know where your money goes and comes from. Revenue tracking, expense management, runway calculation.',
 'finance', 'wallet', '[]', 1, 9,
 '{"1":"recommended","2":"important","3":"critical","4":"critical","5":"critical","6":"critical","7":"critical"}',
 '[{"name":"Monthly burn rate known","target":null,"unit":"boolean"},{"name":"Runway months","target":null,"unit":"months"}]',
 '[]', 2),

(lower(hex(randomblob(16))), 'fundraise_readiness', 'Fundraise Readiness',
 'Passive preparation for fundraising or exit. Data room, metrics history, narrative.',
 'finance', 'briefcase', '["saas_startup","tech_company","b2b_enterprise_saas","education_edtech"]', 2, 9,
 '{"2":"nice_to_have","3":"nice_to_have","4":"recommended","5":"important","6":"important","7":"critical","8":"critical","9":"critical"}',
 '[{"name":"Data room completeness","target":100,"unit":"percent"}]',
 '[]', 2),

-- PRODUCT
(lower(hex(randomblob(16))), 'product_analytics', 'Product Analytics',
 'Understand how people actually use your product. Feature adoption, user flows, drop-off points.',
 'product', 'chart-line', '["saas_startup","ecommerce","tech_company","education_edtech","b2b_enterprise_saas"]', 0, 9,
 '{"0":"important","1":"critical","2":"critical","3":"important","4":"critical"}',
 '[{"name":"Weekly active users","target":null,"unit":"count"},{"name":"Feature adoption rate","target":null,"unit":"percent"}]',
 '[]', 2),

(lower(hex(randomblob(16))), 'competitive_intel', 'Competitive Intelligence',
 'Know what your competitors are doing. Product changes, pricing moves, marketing campaigns.',
 'strategy', 'binoculars', '[]', 0, 9,
 '{"0":"recommended","1":"important","2":"important","3":"recommended","4":"important","5":"important","8":"critical"}',
 '[{"name":"Competitors tracked","target":null,"unit":"count"},{"name":"Intel reports delivered","target":1,"unit":"count_weekly"}]',
 '[]', 2),

(lower(hex(randomblob(16))), 'uptime_monitoring', 'Uptime and Performance Monitoring',
 'Know when things break before your customers tell you. Uptime checks, performance monitoring, alerting.',
 'product', 'activity', '["saas_startup","ecommerce","tech_company","b2b_enterprise_saas"]', 0, 9,
 '{"0":"important","1":"critical","2":"critical","3":"critical","4":"important"}',
 '[{"name":"Uptime percentage","target":99.9,"unit":"percent"},{"name":"Mean time to detection","target":5,"unit":"minutes"}]',
 '[]', 1),

-- TEAM
(lower(hex(randomblob(16))), 'hiring_pipeline', 'Hiring Pipeline',
 'Structured approach to finding and onboarding new team members.',
 'team', 'user-plus', '[]', 3, 9,
 '{"3":"recommended","4":"recommended","5":"important","6":"important","7":"critical","8":"critical"}',
 '[{"name":"Open positions filled","target":null,"unit":"count"},{"name":"Time to hire","target":30,"unit":"days"}]',
 '[]', 4),

(lower(hex(randomblob(16))), 'delegation_system', 'Delegation System',
 'Structured delegation of founder/leader decisions to team members and agents.',
 'team', 'git-branch', '[]', 3, 9,
 '{"3":"critical","4":"critical","5":"important","6":"important","7":"critical"}',
 '[{"name":"Decisions requiring founder","target":null,"unit":"count_weekly"}]',
 '[]', 3),

-- STRATEGY
(lower(hex(randomblob(16))), 'positioning', 'Market Positioning',
 'Clear articulation of who you are, who you serve, and why you''re different.',
 'strategy', 'target', '[]', 0, 9,
 '{"0":"critical","1":"critical","2":"important","3":"recommended","4":"critical","5":"important","8":"critical"}',
 '[{"name":"Positioning statement exists","target":null,"unit":"boolean"}]',
 '[]', 2),

(lower(hex(randomblob(16))), 'customer_research', 'Customer Research',
 'Deep understanding of your customers beyond surface demographics. Jobs-to-be-done, pain points, buying triggers.',
 'strategy', 'microscope', '[]', 0, 9,
 '{"0":"critical","1":"critical","2":"important","3":"recommended","4":"critical"}',
 '[{"name":"Customer interviews this month","target":4,"unit":"count"},{"name":"Personas documented","target":null,"unit":"count"}]',
 '[]', 2);
