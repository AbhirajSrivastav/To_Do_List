const API_BASE_URL = 'http://127.0.0.1:5000';
let authToken = localStorage.getItem('authToken');
let currentUsername = localStorage.getItem('currentUsername');
let currentListId = null;
let allLists = [];
let allTasks = [];
let myChart = null;
let socket = null;

// --- Sound Effects ---
const clickSound = new Audio('https://www.soundjay.com/buttons/button-2.mp3');
const funnySound = new Audio('https://www.soundjay.com/miscellaneous/fail-trombone-01.mp3');
let isAudioInitialized = false;

function initializeAudio() {
    if (!isAudioInitialized) {
        // Attempt to play a silent sound to bypass autoplay restrictions
        clickSound.volume = 0;
        clickSound.play().then(() => {
            clickSound.pause();
            clickSound.currentTime = 0;
            clickSound.volume = 1;
            funnySound.volume = 1;
            isAudioInitialized = true;
        }).catch(e => {
            console.warn("Audio autoplay blocked by browser.");
        });
    }
}

function playClickSound() {
    if (isAudioInitialized) {
        clickSound.currentTime = 0;
        clickSound.play().catch(e => console.error("Error playing click sound:", e));
    }
}

function playFunnySound() {
    if (isAudioInitialized) {
        funnySound.currentTime = 0;
        funnySound.play().catch(e => console.error("Error playing funny sound:", e));
    }
}

function playVideo() {
    const video = document.querySelector('.background-video');
    if (video) {
        video.play().catch(e => {
            console.warn("Video autoplay blocked by browser.");
        });
    }
}

// --- UI Management ---
function showView(viewId) {
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('app-view').style.display = 'none';
    document.body.classList.remove('no-background');
    if (viewId === 'app-view') {
        document.getElementById(viewId).style.display = 'flex';
        document.body.classList.add('no-background');
    } else {
        document.getElementById(viewId).style.display = 'block';
    }
}

function updateDateTime() {
    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const dateString = now.toLocaleDateString('en-US', options);
    const dateDisplay = document.getElementById('datetime-display');
    if (dateDisplay) {
        dateDisplay.textContent = dateString;
    }
}
setInterval(updateDateTime, 1000);

function renderLists(lists) {
    allLists = lists;
    const listMenu = document.getElementById('list-menu');
    listMenu.innerHTML = '';
    lists.forEach(list => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span>${list.name}</span>
            <div class="list-item-controls">
                <button onclick="confirmDeleteList(${list.id}); playClickSound();"><i class="fas fa-trash-alt"></i></button>
            </div>
        `;
        li.dataset.id = list.id;
        li.addEventListener('click', (e) => {
            playClickSound();
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
                return;
            }
            if (socket && currentListId) {
                socket.emit('leave_list', { list_id: currentListId });
            }
            currentListId = list.id;
            socket.emit('join_list', { list_id: currentListId });
            
            document.querySelectorAll('#list-menu li').forEach(item => item.classList.remove('active'));
            li.classList.add('active');
            document.getElementById('current-list-title').textContent = list.name;
            fetchTasks(list.id);
            document.getElementById('add-task-form-section').style.display = 'block';
            document.getElementById('dashboard-section').style.display = 'block';
        });
        listMenu.appendChild(li);
    });
}

function renderTasks(tasks) {
    allTasks = tasks;
    const taskList = document.getElementById('task-list');
    taskList.innerHTML = '';
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.completed).length;

    if (totalTasks > 0) {
        document.getElementById('progress-bar-container').style.display = 'block';
        document.getElementById('progress-bar-fill').style.width = `${(completedTasks / totalTasks) * 100}%`;
        document.getElementById('progress-text').textContent = `${completedTasks}/${totalTasks} Tasks Completed`;
    } else {
        document.getElementById('progress-bar-container').style.display = 'none';
    }

    tasks.forEach(task => {
        const li = document.createElement('li');
        li.classList.add('task-item');
        li.dataset.id = task.id;
        li.dataset.position = task.position;
        if (task.completed) li.classList.add('completed');
        li.innerHTML = `
            <div class="task-info">
                <input type="checkbox" ${task.completed ? 'checked' : ''} onchange="toggleTaskCompletion(${task.id}, this.checked)">
                <span class="task-text">${task.text}</span>
                <div class="task-meta">
                    <span class="priority-badge priority-${task.priority.toLowerCase()}">${task.priority}</span>
                    ${task.due_date ? `<span><i class="far fa-calendar-alt"></i> ${task.due_date}</span>` : ''}
                </div>
            </div>
            <div class="task-actions">
                <button onclick="showEditTaskModal(${task.id}); playClickSound();"><i class="fas fa-edit"></i></button>
                <button onclick="confirmDeleteTask(${task.id}); playClickSound();"><i class="fas fa-trash-alt"></i></button>
            </div>
        `;
        taskList.appendChild(li);
    });

    updateDashboard();
}

function updateDashboard() {
    const priorityCounts = allTasks.reduce((acc, task) => {
        acc[task.priority] = (acc[task.priority] || 0) + 1;
        return acc;
    }, {});

    const chartData = {
        labels: ['High', 'Medium', 'Low'],
        datasets: [{
            label: 'Tasks by Priority',
            data: [priorityCounts['High'] || 0, priorityCounts['Medium'] || 0, priorityCounts['Low'] || 0],
            backgroundColor: [
                '#dc3545',
                '#ffc107',
                '#28a745'
            ],
            hoverOffset: 4
        }]
    };

    if (myChart) {
        myChart.destroy();
    }
    const ctx = document.getElementById('priority-chart').getContext('2d');
    myChart = new Chart(ctx, {
        type: 'doughnut',
        data: chartData,
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: 'top',
                },
                title: {
                    display: true,
                    text: 'Task Priority Distribution'
                }
            }
        },
    });
}

function handleRealtimeUpdate(data) {
    if (data.action === 'add' || data.action === 'update' || data.action === 'delete') {
        fetchTasks(currentListId);
    }
}

// --- API Interaction ---
function getAuthHeaders() {
    return {
        'Content-Type': 'application/json',
        'x-access-token': authToken
    };
}

async function login(username, password) {
    playClickSound();
    playVideo();
    const response = await fetch(`${API_BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const data = await response.json();
    if (response.ok) {
        localStorage.setItem('authToken', data.token);
        localStorage.setItem('currentUsername', username);
        authToken = data.token;
        currentUsername = username;
        document.getElementById('username-display').textContent = currentUsername;
        showView('app-view');
        connectSocketIO();
        fetchLists();
    } else {
        alert(data.message);
        playFunnySound();
    }
}

async function register(username, password) {
    playClickSound();
    playVideo();
    const response = await fetch(`${API_BASE_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const data = await response.json();
    alert(data.message);
    if (response.ok) {
        document.getElementById('login-form').style.display = 'flex';
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('toggle-auth-link').innerHTML = "Already have an account? <a href='#'>Log in here</a>";
    } else {
        playFunnySound();
    }
}

function logout() {
    playClickSound();
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUsername');
    authToken = null;
    currentUsername = null;
    if (socket) {
        socket.disconnect();
    }
    showView('auth-view');
}

async function fetchLists() {
    const response = await fetch(`${API_BASE_URL}/lists`, { headers: getAuthHeaders() });
    if (response.ok) {
        const lists = await response.json();
        renderLists(lists);
    } else {
        alert('Failed to fetch lists. Logging out.');
        playFunnySound();
        logout();
    }
}

async function createList(name) {
    playClickSound();
    await fetch(`${API_BASE_URL}/lists`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name })
    });
    fetchLists();
}

async function fetchTasks(listId) {
    const response = await fetch(`${API_BASE_URL}/lists/${listId}/tasks`, { headers: getAuthHeaders() });
    if (response.ok) {
        const tasks = await response.json();
        renderTasks(tasks);
    }
}

async function addTask(listId, taskData) {
    playClickSound();
    await fetch(`${API_BASE_URL}/lists/${listId}/tasks`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(taskData)
    });
}

async function parseAndAddTask(listId, taskText) {
    playClickSound();
    const response = await fetch(`${API_BASE_URL}/parse-task`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ text: taskText })
    });
    if (response.ok) {
        const parsedData = await response.json();
        addTask(listId, parsedData);
    } else {
        alert('Failed to parse task with AI. Please enter manually.');
        playFunnySound();
        addTask(listId, { text: taskText, priority: 'Medium', due_date: null });
    }
}

async function toggleTaskCompletion(taskId, completed) {
    playClickSound();
    await fetch(`${API_BASE_URL}/tasks/${taskId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ completed: completed })
    });
}

async function updateTask(taskId, taskData) {
    playClickSound();
    await fetch(`${API_BASE_URL}/tasks/${taskId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(taskData)
    });
    document.getElementById('edit-task-modal').style.display = 'none';
    fetchTasks(currentListId); // Re-fetch to ensure order and state are correct
}

async function deleteTask(taskId) {
    playFunnySound();
    await fetch(`${API_BASE_URL}/tasks/${taskId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
    });
}

async function deleteList(listId) {
    playFunnySound();
    await fetch(`${API_BASE_URL}/lists/${listId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
    });
    currentListId = null;
    document.getElementById('current-list-title').textContent = 'Select a List';
    document.getElementById('add-task-form-section').style.display = 'none';
    fetchLists();
}

function showEditTaskModal(taskId) {
    playClickSound();
    const task = allTasks.find(t => t.id === taskId);
    if (!task) return;
    
    document.getElementById('edit-task-id').value = task.id;
    document.getElementById('edit-task-text').value = task.text;
    document.getElementById('edit-task-priority').value = task.priority;
    document.getElementById('edit-task-due-date').value = task.due_date || '';
    document.getElementById('edit-task-modal').style.display = 'flex';
}

function confirmDeleteTask(taskId) {
    playClickSound();
    showModal('Delete Task', 'Are you sure you want to delete this task?', () => {
        deleteTask(taskId);
    });
}

function confirmDeleteList(listId) {
    playClickSound();
    showModal('Delete List', 'Are you sure you want to delete this list and all its tasks?', () => {
        deleteList(listId);
    });
}
function showModal(title, message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-message').textContent = message;
    modal.style.display = 'flex';
    document.getElementById('modal-confirm-btn').onclick = () => {
        onConfirm();
        modal.style.display = 'none';
    };
    document.getElementById('modal-cancel-btn').onclick = () => {
        modal.style.display = 'none';
    };
}


function connectSocketIO() {
    socket = io(API_BASE_URL);

    socket.on('connect', () => {
        console.log('Connected to WebSocket server.');
        if (currentListId) {
            socket.emit('join_list', { list_id: currentListId });
        }
    });

    socket.on('task_update', (data) => {
        if (data.action === 'add' || data.action === 'update' || data.action === 'delete') {
            fetchTasks(currentListId);
        }
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from WebSocket server.');
    });
}

function initSortable() {
    const taskListEl = document.getElementById('task-list');
    new Sortable(taskListEl, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        onEnd: function (evt) {
            const newOrder = [...taskListEl.children].map((el, index) => ({
                id: el.dataset.id,
                position: index
            }));
            fetch(`${API_BASE_URL}/tasks/reorder`, {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify({ list_id: currentListId, task_ids: newOrder.map(item => item.id) })
            });
            fetchTasks(currentListId);
        }
    });
}


// --- Event Listeners and Initial App Logic ---
document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    login(username, password);
});

document.getElementById('register-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('register-username').value;
    const password = document.getElementById('register-password').value;
    register(username, password);
});

document.getElementById('toggle-auth-link').addEventListener('click', (e) => {
    e.preventDefault();
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const toggleLink = document.getElementById('toggle-auth-link');
    
    if (loginForm.style.display === 'none') {
        loginForm.style.display = 'flex';
        registerForm.style.display = 'none';
        toggleLink.innerHTML = "Don't have an account? <a href='#'>Register here</a>";
    } else {
        loginForm.style.display = 'none';
        registerForm.style.display = 'flex';
        toggleLink.innerHTML = "Already have an account? <a href='#'>Log in here</a>";
    }
});

document.getElementById('logout-btn').addEventListener('click', logout);

document.getElementById('add-list-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const listName = document.getElementById('new-list-name').value;
    createList(listName);
    document.getElementById('new-list-name').value = '';
});

document.getElementById('add-task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const taskText = document.getElementById('new-task-text').value;
    parseAndAddTask(currentListId, taskText);
    document.getElementById('new-task-text').value = '';
});

document.getElementById('edit-task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const taskId = document.getElementById('edit-task-id').value;
    const taskText = document.getElementById('edit-task-text').value;
    const priority = document.getElementById('edit-task-priority').value;
    const dueDate = document.getElementById('edit-task-due-date').value;
    updateTask(taskId, { text: taskText, priority, due_date: dueDate });
});

document.getElementById('cancel-edit-btn').addEventListener('click', () => {
    document.getElementById('edit-task-modal').style.display = 'none';
});

document.getElementById('delete-list-btn').addEventListener('click', () => {
    if (currentListId) {
        confirmDeleteList(currentListId);
    }
});

document.getElementById('theme-toggle').addEventListener('click', () => {
    document.body.classList.toggle('theme-dark');
});


document.addEventListener('DOMContentLoaded', () => {
    initializeAudio(); 
    if (authToken && currentUsername) {
        document.getElementById('username-display').textContent = currentUsername;
        showView('app-view');
        connectSocketIO();
        fetchLists();
        initSortable();
    } else {
        showView('auth-view');
    }
});
