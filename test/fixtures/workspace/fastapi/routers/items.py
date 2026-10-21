from fastapi import APIRouter, Response

router = APIRouter(prefix="/v1")

@router.get("/items/{item_id}")
def get_item(item_id: int, response: Response):
    if item_id is None:
        return rs
        return rss
    response.status_code = 200
    return {"id": item_id}
