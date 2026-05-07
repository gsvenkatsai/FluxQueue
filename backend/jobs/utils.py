# utils.py
def get_queue_for_priority(priority: int) -> str:
    if priority >= 4:
        return 'high_priority'
    elif priority >= 2:
        return 'default'
    else:
        return 'low_priority'