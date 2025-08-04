from flask import Flask, request, jsonify, render_template
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from flask_bcrypt import Bcrypt
from flask_socketio import SocketIO, emit, join_room, leave_room
from datetime import datetime, timedelta
import jwt
from functools import wraps
from sqlalchemy.exc import IntegrityError
import json
import requests
import os
from waitress import serve

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///todo_advanced.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = 'your_super_secret_key' # CHANGE THIS
CORS(app)
db = SQLAlchemy(app)
bcrypt = Bcrypt(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Gemini API configuration
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=" + (GEMINI_API_KEY if GEMINI_API_KEY else '')

# --- Database Models ---
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    lists = db.relationship('List', backref='user', lazy=True, cascade='all, delete-orphan')

class List(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    tasks = db.relationship('Task', backref='list', lazy=True, cascade='all, delete-orphan')

class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    text = db.Column(db.String(200), nullable=False)
    completed = db.Column(db.Boolean, default=False)
    priority = db.Column(db.String(10), default='Medium') # High, Medium, Low
    due_date = db.Column(db.String(20), nullable=True)
    list_id = db.Column(db.Integer, db.ForeignKey('list.id'), nullable=False)
    position = db.Column(db.Integer, nullable=True) # For drag-and-drop order

# Create the database tables
with app.app_context():
    db.create_all()

# --- JWT Token Verification Decorator ---
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'x-access-token' in request.headers:
            token = request.headers['x-access-token']
        if not token:
            return jsonify({'message': 'Token is missing!'}), 401
        try:
            data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=["HS256"])
            current_user = User.query.filter_by(id=data['user_id']).first()
        except jwt.ExpiredSignatureError:
            return jsonify({'message': 'Token has expired!'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'message': 'Token is invalid!'}), 401
        return f(current_user, *args, **kwargs)
    return decorated

# --- SocketIO Events ---
@socketio.on('connect')
def handle_connect():
    print('Client connected')

@socketio.on('join_list')
def handle_join_list(data):
    list_id = data.get('list_id')
    if list_id:
        room = f'list_{list_id}'
        join_room(room)
        print(f'Client joined room: {room}')

@socketio.on('leave_list')
def handle_leave_list(data):
    list_id = data.get('list_id')
    if list_id:
        room = f'list_{list_id}'
        leave_room(room)
        print(f'Client left room: {room}')

# --- Route to Serve Frontend ---
@app.route('/')
def serve_index():
    return render_template('index.html')

# --- NLP Endpoint for Task Parsing ---
@app.route('/parse-task', methods=['POST'])
@token_required
def parse_task_nlp(current_user):
    if not GEMINI_API_KEY:
        app.logger.error("Gemini API key is not set.")
        return jsonify({"error": "AI parsing is not available. Please set the API key."}), 503

    task_text = request.json.get('text', '')
    if not task_text:
        return jsonify({'error': 'No text provided'}), 400

    prompt = f"""
    You are a task management assistant. Your job is to extract task details from a user's natural language input.
    The user will provide a single task description. You must extract the task text, a priority (High, Medium, or Low), and a due date.
    
    If no priority is mentioned, default to 'Medium'.
    If no date is mentioned, return a null value for due_date.
    
    The output must be a JSON object with the following keys:
    'text': string (the main task description)
    'priority': string (either 'High', 'Medium', or 'Low')
    'due_date': string (in 'YYYY-MM-DD' format, or null)
    
    Example input: "Buy groceries for tomorrow's dinner"
    Example output:
    {{
      "text": "Buy groceries for dinner",
      "priority": "Medium",
      "due_date": "{datetime.now().strftime('%Y-%m-%d')}"
    }}
    
    Example input: "Finish the report by Friday, it's urgent"
    Example output:
    {{
      "text": "Finish the report",
      "priority": "High",
      "due_date": "{datetime.now().strftime('%Y-%m-%d')}"
    }}

    Now, process the following input: "{task_text}"
    """

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "text": {"type": "STRING"},
                    "priority": {"type": "STRING", "enum": ["High", "Medium", "Low"]},
                    "due_date": {"type": "STRING", "format": "date", "nullable": True}
                }
            }
        }
    }
    
    headers = {"Content-Type": "application/json"}
    try:
        response = requests.post(GEMINI_API_URL, headers=headers, data=json.dumps(payload))
        response.raise_for_status()
        data = response.json()
        
        response_text = data['candidates'][0]['content']['parts'][0]['text']
        parsed_data = json.loads(response_text)
        
        return jsonify(parsed_data)
    except requests.exceptions.RequestException as e:
        app.logger.error(f"Error calling Gemini API: {e}")
        return jsonify({"error": "Failed to parse task with AI due to API request error."}), 500
    except (KeyError, json.JSONDecodeError) as e:
        app.logger.error(f"Error parsing Gemini API response: {e}, Response: {response.text}")
        return jsonify({"error": "Failed to parse API response."}), 500

# --- Auth Routes ---
@app.route('/register', methods=['POST'])
def register():
    data = request.get_json()
    try:
        if User.query.filter_by(username=data['username']).first():
            return jsonify({'message': 'Username already exists'}), 409

        hashed_password = bcrypt.generate_password_hash(data['password']).decode('utf-8')
        new_user = User(username=data['username'], password_hash=hashed_password)
        db.session.add(new_user)
        db.session.commit()
        return jsonify({'message': 'User registered successfully!'}), 201
    except IntegrityError:
        db.session.rollback()
        return jsonify({'message': 'An error occurred during registration. Please try again.'}), 500

@app.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    user = User.query.filter_by(username=data['username']).first()
    if not user or not bcrypt.check_password_hash(user.password_hash, data['password']):
        return jsonify({'message': 'Invalid credentials'}), 401
    
    token = jwt.encode({'user_id': user.id, 'username': user.username, 'exp': datetime.utcnow() + timedelta(hours=24)},
                       app.config['SECRET_KEY'], algorithm="HS256")
    return jsonify({'token': token, 'username': user.username}), 200

# --- API Endpoints ---
@app.route('/lists', methods=['GET'])
@token_required
def get_lists(current_user):
    lists = List.query.filter_by(user_id=current_user.id).order_by(List.id).all()
    output = [{'id': l.id, 'name': l.name} for l in lists]
    return jsonify(output)

@app.route('/lists', methods=['POST'])
@token_required
def create_list(current_user):
    data = request.get_json()
    new_list = List(name=data['name'], user_id=current_user.id)
    db.session.add(new_list)
    db.session.commit()
    # emit a real-time event to the user's personal room
    socketio.emit('list_update', {'action': 'add', 'list': {'id': new_list.id, 'name': new_list.name}}, room=f'user_{current_user.id}')
    return jsonify({'message': 'List created!', 'id': new_list.id, 'name': new_list.name}), 201

@app.route('/lists/<int:list_id>', methods=['DELETE'])
@token_required
def delete_list(current_user, list_id):
    list_to_delete = List.query.filter_by(id=list_id, user_id=current_user.id).first_or_404()
    db.session.delete(list_to_delete)
    db.session.commit()
    # emit a real-time event to the user's personal room
    socketio.emit('list_update', {'action': 'delete', 'list_id': list_id}, room=f'user_{current_user.id}')
    return jsonify({'message': 'List deleted!'})

@app.route('/lists/<int:list_id>/tasks', methods=['GET'])
@token_required
def get_tasks(current_user, list_id):
    tasks = Task.query.filter_by(list_id=list_id).order_by(Task.position).all()
    output = [{'id': t.id, 'text': t.text, 'completed': t.completed, 'priority': t.priority, 'due_date': t.due_date, 'position': t.position} for t in tasks]
    return jsonify(output)

@app.route('/lists/<int:list_id>/tasks', methods=['POST'])
@token_required
def add_task(current_user, list_id):
    data = request.get_json()
    new_task = Task(text=data['text'], list_id=list_id, priority=data.get('priority', 'Medium'), due_date=data.get('due_date'))
    db.session.add(new_task)
    db.session.commit()
    emit('task_update', {'action': 'add', 'task': {'id': new_task.id, 'text': new_task.text}}, room=f'list_{list_id}')
    return jsonify({'message': 'Task added!', 'id': new_task.id}), 201

@app.route('/tasks/reorder', methods=['PUT'])
@token_required
def reorder_tasks(current_user):
    data = request.get_json()
    list_id = data.get('list_id')
    task_ids = data.get('task_ids')

    tasks_to_update = Task.query.filter_by(list_id=list_id).all()
    task_map = {task.id: task for task in tasks_to_update}

    for index, task_id in enumerate(task_ids):
        if task_id in task_map:
            task_map[task_id].position = index

    db.session.commit()
    return jsonify({'message': 'Tasks reordered!'})

@app.route('/tasks/<int:task_id>', methods=['PUT'])
@token_required
def update_task(current_user, task_id):
    task = Task.query.get_or_404(task_id)
    data = request.get_json()
    task.text = data.get('text', task.text)
    task.completed = data.get('completed', task.completed)
    task.priority = data.get('priority', task.priority)
    task.due_date = data.get('due_date', task.due_date)
    db.session.commit()

    emit('task_update', {'action': 'update', 'task': {'id': task.id, 'completed': task.completed, 'text': task.text}}, room=f'list_{task.list_id}')
    return jsonify({'message': 'Task updated!'})

@app.route('/tasks/<int:task_id>', methods=['DELETE'])
@token_required
def delete_task(current_user, task_id):
    task = Task.query.get_or_404(task_id)
    list_id = task.list_id
    db.session.delete(task)
    db.session.commit()
    emit('task_update', {'action': 'delete', 'task_id': task_id}, room=f'list_{list_id}')
    return jsonify({'message': 'Task deleted!'})

if __name__ == '__main__':
    socketio.run(app, debug=True)
