# Facility Reservation System

A simple role-based facility reservation and approval system for Systems Analysis and Design Laboratory 4 Section B.

## Technologies
- GitHub
- GitHub Pages
- Supabase
- HTML/CSS/JavaScript

## Features
- Requester signup/login
- Role-based access: Administrator, Facility Staff, Requester
- Facility viewing
- Reservation submission
- Reservation conflict checking
- Administrator approval/rejection
- Facility Staff status updates
- Requester cancellation of own Pending requests
- Audit logging
- Row Level Security (RLS)

## Setup

### 1. Create Supabase project
Create a project in Supabase.

### 2. Create the database
Open Supabase -> SQL Editor and run the complete `supabase.sql` file.

### 3. Get Supabase credentials
Open your Supabase project's API settings and copy:
- Project URL
- anon/public key

### 4. Put credentials in app.js
Replace:

SUPABASE_URL = "PASTE_YOUR_SUPABASE_PROJECT_URL_HERE"
SUPABASE_ANON_KEY = "PASTE_YOUR_SUPABASE_ANON_PUBLIC_KEY_HERE"

Do not use the service_role key in the website.

### 5. Create accounts
Use the Sign up form on the website. New accounts are Requesters.

To create an Administrator or Facility Staff account:
1. Sign up the account normally.
2. In Supabase SQL Editor run:

update public.profiles
set role='Administrator'
where email='YOUR_ADMIN_EMAIL@example.com';

For staff:

update public.profiles
set role='Facility Staff'
where email='YOUR_STAFF_EMAIL@example.com';

### 6. Upload to GitHub
Upload:
- index.html
- app.js
- styles.css
- supabase.sql
- README.md

### 7. GitHub Pages
Repository -> Settings -> Pages:
- Source: Deploy from a branch
- Branch: main
- Folder: / (root)

Expected URL:
https://grace14-sys.github.io/facility-reservation-system/

## Important
The supplied SQL and frontend are a working starting implementation of the laboratory requirements. Perform the required test cases in your own environment before submitting results as actual evidence.
