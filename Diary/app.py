import os
from dotenv import load_dotenv 
load_dotenv()

import secrets
import json
from datetime import datetime
from urllib.parse import urlparse 

# Flask and SQLAlchemy imports
from flask import Flask, current_app, render_template, request, redirect, url_for, flash, jsonify, session
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import UserMixin, login_user, LoginManager, current_user, logout_user, login_required

# Flask-Mail and itsdangerous imports
from flask_mail import Mail, Message
from itsdangerous import URLSafeTimedSerializer as Serializer, SignatureExpired, BadSignature

# --- Configuration ---
app = Flask(__name__)

# 1. SECRET_KEY FIX
SECRET_KEY = os.environ.get(
    'SECRET_KEY', 
    'DEFAULT_FALLBACK_KEY_CHANGE_ME_IMMEDIATELY_IN_PROD' 
)
# CRITICAL FIX: Ensure the secret key is always a non-empty string, and explicitly 
# convert it to bytes for the cryptographic functions (itsdangerous).
if isinstance(SECRET_KEY, str):
    app.config['SECRET_KEY'] = SECRET_KEY
else:
    # If the key is somehow not a string, use the fallback and encode it.
    app.config['SECRET_KEY'] = 'DEFAULT_FALLBACK_KEY_CHANGE_ME_IMMEDIATELY_IN_PROD'.encode('utf-8')


# 2. Database Configuration
USER = os.environ.get('POSTGRES_USER', 'postgres')  # Using common POSTGRES_ prefix
PASSWORD = os.environ.get('POSTGRES_PASSWORD', 'postgre')  # Using common POSTGRES_ prefix
HOST = os.environ.get('POSTGRES_HOST', 'localhost')
PORT = os.environ.get('POSTGRES_PORT', '5432')
DB_NAME = os.environ.get('POSTGRES_DB', 'encrypted_diary_db')

DATABASE_URL = f'postgresql://{USER}:{PASSWORD}@{HOST}:{PORT}/{DB_NAME}'

app.config['SQLALCHEMY_DATABASE_URI'] = DATABASE_URL
app.config['SQLALCHEMY_TRACK_MODELS'] = False

# 3. Flask-Mail Configuration
app.config['MAIL_SERVER'] = os.environ.get('MAIL_SERVER', 'smtp.gmail.com')
app.config['MAIL_PORT'] = int(os.environ.get('MAIL_PORT', 587))
app.config['MAIL_USE_TLS'] = os.environ.get('MAIL_USE_TLS', 'True').lower() in ('true', '1', 't')
app.config['MAIL_DEBUG'] = True
app.config['MAIL_USERNAME'] = os.environ.get('MAIL_USERNAME', 'YOUR_EMAIL_ADDRESS@gmail.com')
app.config['MAIL_PASSWORD'] = os.environ.get('MAIL_PASSWORD', 'YOUR_EMAIL_APP_PASSWORD')
app.config['MAIL_DEFAULT_SENDER'] = os.environ.get('MAIL_DEFAULT_SENDER', app.config['MAIL_USERNAME'])

# Initialize extensions
db = SQLAlchemy(app)
mail = Mail(app) 

# Flask-Login setup
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'
login_manager.login_message_category = 'danger'

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# --- Database Models ---

class User(UserMixin, db.Model):
    __tablename__ = 'users' 
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    
    password_hash = db.Column(db.String(255), nullable=False) 
    entries = db.relationship('Entry', backref='author', lazy='dynamic')

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)
    
    def get_reset_token(self, expires_sec=1800):
        s = Serializer(
            secret_key=current_app.config['SECRET_KEY'],
            salt='password-reset-salt'
        )
        return s.dumps({'user_id': self.id})

    @staticmethod
    def verify_reset_token(token):
        s = Serializer(
            secret_key=current_app.config['SECRET_KEY'],
            salt='password-reset-salt'
        )
        try:
            data = s.loads(token, max_age=1800)
        except (SignatureExpired, BadSignature):
            return None
        return User.query.get(data['user_id'])


class Entry(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    encrypted_title = db.Column(db.String(500), nullable=False)
    encrypted_content = db.Column(db.Text, nullable=False)
    
    date_created = db.Column(db.DateTime, default=datetime.utcnow)
    date_modified = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False) 

# --- CLI Commands ---

@app.cli.command('init-db')
def init_db_command():
    
    try:
        db.drop_all()
        db.create_all()
        print('Database initialized! Tables (users, entry) created or reset.')
    except Exception as e:
        print(f"Error initializing database: {e}")

# --- Helper Function for Email ---
def send_reset_email(user):
    with app.app_context():
        # This line calls the function that was causing the error
        token = user.get_reset_token()
        msg = Message('Personal Diary - Password Reset Request',
                      sender=app.config['MAIL_DEFAULT_SENDER'],
                      recipients=[user.email])
        
        reset_url = url_for('reset_token', token=token, _external=True)
        
        msg.body = f"""To reset your password, visit the following link:
{reset_url}

If you did not make this request then simply ignore this email and no changes will be made.
The link will expire in 30 minutes.
"""
        
        if app.config.get('MAIL_USERNAME') == 'YOUR_EMAIL_ADDRESS@gmail.com' or not app.config.get('MAIL_USERNAME'):
            flash('Email service is not fully configured. Please check MAIL_USERNAME/PASSWORD in .env.', 'danger')
            print("WARNING: Email skipped because MAIL_USERNAME is the default placeholder or empty.")
            return

        try:
            mail.send(msg)
            flash(f'An email has been sent to {user.email} with instructions to reset your password.', 'info')
        except Exception as e:
            print(f"Flask-Mail Error: Could not send email. Check MAIL_ settings in .env. Error: {e}")
            flash('Password reset link could not be sent due to an email service error. Please check your credentials.', 'danger')
        

# --- Routes: Authentication ---

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('diary'))
        
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        
        if not email or not password:
            flash('Both email and password are required.', 'danger')
            return redirect(url_for('register'))
            
        if User.query.filter_by(email=email).first():
            flash('Email already registered. Please log in or use a different one.', 'danger')
            return redirect(url_for('register'))

        try:
            new_user = User(email=email)
            new_user.set_password(password)
            db.session.add(new_user)
            db.session.commit()
            flash('Registration successful! Please log in.', 'success')
            return redirect(url_for('login'))
        except Exception as e:
            db.session.rollback()
            flash('An internal error occurred during registration. Please try again.', 'danger')
            print(f"Registration Error: {e}")
            return redirect(url_for('register'))

    return render_template('register.html')
  
@app.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if current_user.is_authenticated:
        return redirect(url_for('diary'))
        
    if request.method == 'POST':
        email = request.form.get('email')
        user = User.query.filter_by(email=email).first()
        
        if user:
            send_reset_email(user)
        
        # We give a generic message regardless of if the user exists for security reasons
        flash('If your email is in our system, you will receive a password reset link shortly.', 'info')
        return redirect(url_for('login'))
    
    return render_template('forgot_password.html')

@app.route("/reset-password/<token>", methods=['GET', 'POST'])
def reset_token(token):
    if current_user.is_authenticated:
        return redirect(url_for('diary'))
        
    user = User.verify_reset_token(token)
    
    if user is None:
        flash('That is an invalid or expired token.', 'danger')
        return redirect(url_for('forgot_password'))

    if request.method == 'POST':
        password = request.form.get('password')
        confirm_password = request.form.get('confirm_password')

        if password != confirm_password:
            flash('Passwords must match.', 'danger')
            return render_template('reset_token.html', token=token)

        user.set_password(password)
        db.session.commit()
        flash('Your password has been updated! Please log in with your new password.', 'success')
        return redirect(url_for('login'))

    return render_template('reset_token.html', token=token)
 
  
@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('diary'))

    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        
        user = User.query.filter_by(email=email).first()
        
        if user and user.check_password(password):
            login_user(user)
            
            if 'first_login' not in session:
                flash('Welcome! Please enter your master diary password to unlock your entries.', 'success')
                session['first_login'] = True
            
            return redirect(url_for('diary'))
        else:
            flash('Invalid email or password.', 'danger')
            return redirect(url_for('login'))
            
    return render_template('index.html') 

@app.route('/logout')
@login_required
def logout():
    logout_user()
    if 'first_login' in session:
        session.pop('first_login')
    flash('You have been logged out.', 'success')
    return redirect(url_for('login'))


@app.route('/')
@login_required
def diary():
    """Main application page to display the diary interface."""
    return render_template('diary.html') 


@app.route('/api/entries', methods=['GET'])
@login_required
def get_entries():
    """Retrieves all encrypted entries for the current user."""
    entries = Entry.query.filter_by(user_id=current_user.id).order_by(Entry.date_modified.desc()).all()
    
    return jsonify([{
        'id': entry.id,
        'encrypted_title': entry.encrypted_title,
        'encrypted_content': entry.encrypted_content,
        'date_created': entry.date_created.strftime('%Y-%m-%d %H:%M:%S'),
        'date_modified': entry.date_modified.strftime('%Y-%m-%d %H:%M:%S')
    } for entry in entries]), 200


@app.route('/api/entries', methods=['POST'])
@login_required
def create_entry():
    """Creates a new encrypted diary entry."""
    data = request.json
    
    encrypted_title = data.get('encrypted_title')
    encrypted_content = data.get('encrypted_content')

    if not encrypted_title or not encrypted_content:
        return jsonify({'error': 'Missing encrypted title or content'}), 400

    new_entry = Entry(
        encrypted_title=encrypted_title,
        encrypted_content=encrypted_content,
        user_id=current_user.id
    )
    
    try:
        db.session.add(new_entry)
        db.session.commit()
        return jsonify({
            'message': 'Entry created successfully.',
            'id': new_entry.id,
            'date_modified': new_entry.date_modified.strftime('%Y-%m-%d %H:%M:%S')
        }), 201
    except Exception as e:
        db.session.rollback()
        print(f"Error creating entry: {e}")
        return jsonify({'error': 'Database error while creating entry.'}), 500


@app.route('/api/entries/<int:entry_id>', methods=['PUT'])
@login_required
def update_entry(entry_id):
    """Updates an existing encrypted diary entry."""
    entry = Entry.query.get_or_404(entry_id)
    
    if entry.user_id != current_user.id:
        return jsonify({'error': 'Unauthorized access'}), 403

    data = request.json
    
    encrypted_title = data.get('encrypted_title')
    encrypted_content = data.get('encrypted_content')

    if not encrypted_title or not encrypted_content:
        return jsonify({'error': 'Missing encrypted title or content'}), 400

    entry.encrypted_title = encrypted_title
    entry.encrypted_content = encrypted_content
    db.session.commit()
    
    return jsonify({
        'message': 'Entry updated successfully.',
        'id': entry.id,
        'date_modified': entry.date_modified.strftime('%Y-%m-%d %H:%M:%S')
    }), 200

@app.route('/api/entries/<int:entry_id>', methods=['DELETE'])
@login_required
def delete_entry(entry_id):
    """Deletes a diary entry."""
    entry = Entry.query.get_or_404(entry_id)
    
    if entry.user_id != current_user.id:
        return jsonify({'error': 'Unauthorized access'}), 403

    db.session.delete(entry)
    db.session.commit()
    
    return jsonify({'message': 'Entry deleted successfully.'}), 200

if __name__ == '__main__':
    app.run(debug=True)