from fastapi import FastAPI, Response

app = FastAPI()


@app.get("/multiline")
def multiline(response: Response):
    return (
        rs
    )
